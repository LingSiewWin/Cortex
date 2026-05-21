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

let _mmr: MMR | undefined;
let _initPromise: Promise<MMR> | undefined;

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
    const leaves = listLeafHashesInOrder(db);
    for (const leaf of leaves) {
      const bytes = hexToBytes32(leaf.payloadHash);
      if (!bytes) continue; // skip malformed
      mmr.append(bytes);
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
}> {
  const mmr = await getStateMMR();
  const bytes = hexToBytes32(payloadHashHex);
  if (!bytes) {
    throw new Error(
      `appendToStateMMR: invalid hash ${payloadHashHex} (expected 32-byte 0x hex)`,
    );
  }
  const { leafIndex } = mmr.append(bytes);
  return {
    leafIndex,
    newRoot: mmr.getRootHex(),
    leafCount: mmr.size(),
  };
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
