/**
 * Cortex — process-singleton MMR accumulator.
 *
 * Lifecycle:
 *   - First call to getStateMMR() reads all payload_hashes from SQLite in
 *     canonical insertion order and rebuilds the MMR by appending each leaf.
 *   - Subsequent calls return the cached instance.
 *   - The daemon's hydrateEntity and the batch-writer ingestion hook call
 *     appendToStateMMR() after persisting a new payload_hash to SQLite.
 *
 * Why a singleton: the MMR holds ~O(N) memory and must reflect SQLite truth.
 * Re-instantiating per request would either be expensive or drift from disk.
 *
 * Failure mode: if SQLite has 10k entities, cold start is ~50ms on M3 per the
 * bench (scripts/mmr-bench.ts). For 1M entities, this is the migration point
 * to persist intermediate nodes (a Phase 14 concern).
 */

import { type Hex } from "viem";
import {
  initMirrorDb,
  insertStateRoot,
  listLeafHashesInOrder,
  listRecentStateRoots,
  type StateRootRow,
} from "./db";
import { MMR } from "./mmr";
import { publish } from "../lib/events";

let _mmr: MMR | undefined;
let _initPromise: Promise<MMR> | undefined;
/**
 * Leaf-hash → leafIndex of every leaf already in the MMR. Makes appendToStateMMR
 * IDEMPOTENT: the anchor worker appends a citation leaf at drain time, and the
 * mirror daemon later re-observes that same on-chain CITATION entity and would
 * append it again — without this guard the leaf lands twice (different positions)
 * and the live root diverges from any rebuilt root. Citation payloads embed a
 * unique observedAtMs, so identical hashes are genuine re-appends, not collisions.
 */
let _appendedIndex: Map<string, number> = new Map();

/**
 * Get the process-wide MMR instance, building it from SQLite on first call.
 * Safe to call concurrently — concurrent callers share the same init promise.
 */
export async function getStateMMR(): Promise<MMR> {
  if (_mmr) return _mmr;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    const db = await initMirrorDb();
    const mmr = new MMR();
    _appendedIndex = new Map();
    const leaves = listLeafHashesInOrder(db);
    for (const leaf of leaves) {
      const norm = leaf.payloadHash.toLowerCase();
      if (_appendedIndex.has(norm)) continue; // dedup on rebuild too
      const bytes = hexToBytes32(leaf.payloadHash);
      if (!bytes) continue; // skip malformed
      const { leafIndex } = mmr.append(bytes);
      _appendedIndex.set(norm, leafIndex);
    }
    _mmr = mmr;
    return mmr;
  })();
  return _initPromise;
}

/**
 * Append a new payload hash to the singleton MMR. The caller is responsible
 * for persisting the hash to SQLite FIRST so a cold restart rebuilds the
 * same sequence.
 *
 * Returns the leaf index assigned to this leaf.
 */
export async function appendToStateMMR(payloadHashHex: Hex): Promise<{
  leafIndex: number;
  newRoot: Hex;
  leafCount: number;
  /** true when the leaf was already present and this call was a no-op (idempotent). */
  deduped?: boolean;
}> {
  const mmr = await getStateMMR();
  const bytes = hexToBytes32(payloadHashHex);
  if (!bytes) {
    throw new Error(
      `appendToStateMMR: invalid hash ${payloadHashHex} (expected 32-byte 0x hex)`,
    );
  }
  // Idempotent: a leaf appended by the anchor worker must not be re-appended when
  // the daemon later syncs the same CITATION entity (or when a failed bundle is
  // retried). Return the existing position without mutating the tree or emitting.
  const norm = payloadHashHex.toLowerCase();
  const existing = _appendedIndex.get(norm);
  if (existing !== undefined) {
    return { leafIndex: existing, newRoot: mmr.getRootHex(), leafCount: mmr.size(), deduped: true };
  }
  const { leafIndex } = mmr.append(bytes);
  _appendedIndex.set(norm, leafIndex);
  const newRoot = mmr.getRootHex();
  const leafCount = mmr.size();
  // Emit on the live spine. We instrument HERE (the singleton wrapper) rather
  // than MMR.append() so the pure data structure stays decoupled and the
  // 10k-append bench (scripts/mmr-bench.ts, tests/mmr.test.ts) doesn't flood
  // the bus.
  publish({
    type: "mmr.appended",
    ts: Date.now(),
    leafIndex,
    leafHash: payloadHashHex,
    newRoot,
    leafCount,
  });
  return { leafIndex, newRoot, leafCount };
}

/**
 * Snapshot the current MMR root and persist a state_roots row. Phase 13's
 * Arkiv anchor flow will look at the most recent unanchored row from
 * listRecentStateRoots() and broadcast it.
 *
 * trigger reason captures WHY the snapshot was taken — useful for debugging
 * and for explaining state transitions to judges.
 */
export async function commitStateRoot(
  triggerReason: "manual" | "act" | "periodic" | "boot",
): Promise<{ rootHex: Hex; leafCount: number; id: number }> {
  const mmr = await getStateMMR();
  const rootHex = mmr.getRootHex();
  const leafCount = mmr.size();
  const db = await initMirrorDb();
  // UNIQUE on root_hex means re-committing the same root is a no-op. Catch
  // and resolve to the existing row id so callers can chain safely.
  let id: number;
  try {
    id = insertStateRoot(db, { rootHex, leafCount, triggerReason });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE/i.test(msg)) {
      const existing = db
        .prepare("SELECT id FROM state_roots WHERE root_hex = ?")
        .get(rootHex) as { id: number } | null;
      if (!existing) throw err;
      id = existing.id;
    } else {
      throw err;
    }
  }
  return { rootHex, leafCount, id };
}

export async function getRecentStateRoots(
  limit = 20,
): Promise<StateRootRow[]> {
  const db = await initMirrorDb();
  return listRecentStateRoots(db, limit);
}

/** Test seam — drops the singleton so tests can rebuild from a fresh DB. */
export function resetStateMMRForTests(): void {
  _mmr = undefined;
  _initPromise = undefined;
  _appendedIndex = new Map();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hexToBytes32(hex: string): Uint8Array | null {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length !== 64) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    const byte = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) return null;
    out[i] = byte;
  }
  return out;
}
