/**
 * Cortex — bun:sqlite mirror database.
 *
 * Single connection per process. Schema loaded from schema.sql on first open.
 * Safe to call initMirrorDb() multiple times — returns the same instance.
 */

import { Database } from "bun:sqlite";
import { bytesToHex, keccak256 } from "viem";
import type { Hex } from "@arkiv-network/sdk";
import type { Attribute } from "@arkiv-network/sdk/types";
import {
  verifySessionAuthorizationV2,
} from "../lib/session-key";
import type { SessionAuthorizationV2 } from "../lib/eip712";
import { normaliseAddress } from "../lib/arkiv-client";

const DEFAULT_MIRROR_PATH = "./cortex-mirror.sqlite";
const SCHEMA_URL = new URL("./schema.sql", import.meta.url);

let _db: Database | undefined;

/**
 * Open (or create) the SQLite mirror and apply schema.sql. Idempotent — subsequent
 * calls return the cached connection. Must be awaited before any query.
 */
export async function initMirrorDb(path?: string): Promise<Database> {
  if (_db) return _db;
  const resolved = path ?? process.env.CORTEX_MIRROR_PATH ?? DEFAULT_MIRROR_PATH;
  const db = new Database(resolved, { create: true });
  // Apply pragmas BEFORE schema DDL — pragmas need to run on every fresh
  // connection (some are connection-scoped, like busy_timeout). The schema
  // file repeats them as documentation, but bun:sqlite's `exec()` applies them
  // in order so the explicit set here guarantees they're active even if the
  // schema parse changes in future. See docs/MIRROR.md §1.
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  const ddl = await Bun.file(SCHEMA_URL).text();
  db.exec(ddl);
  // Phase 12 migration — add payload_hash column to existing entities tables
  // that predate the schema change, then backfill any rows that have a
  // payload but no hash. SQLite ALTER TABLE ADD COLUMN has no IF NOT EXISTS,
  // so we use PRAGMA table_info to detect.
  migrateAddPayloadHash(db);
  migrateAddUtilityWeights(db);
  _db = db;
  return db;
}

/**
 * SEDM-fusion migration: ensure the utility-weight columns exist on
 * `citation_counts` for databases that predate the fusion. Idempotent.
 */
function migrateAddUtilityWeights(db: Database): void {
  const cols = db.prepare("PRAGMA table_info(citation_counts)").all() as Array<{
    name: string;
  }>;
  const have = new Set(cols.map((c) => c.name));
  if (!have.has("weight")) {
    db.exec("ALTER TABLE citation_counts ADD COLUMN weight REAL NOT NULL DEFAULT 1.0;");
  }
  if (!have.has("last_weight_ms")) {
    db.exec("ALTER TABLE citation_counts ADD COLUMN last_weight_ms INTEGER;");
  }
  if (!have.has("audit_s")) {
    db.exec("ALTER TABLE citation_counts ADD COLUMN audit_s REAL;");
  }
  if (!have.has("audit_epoch")) {
    db.exec("ALTER TABLE citation_counts ADD COLUMN audit_epoch INTEGER;");
  }
}

/**
 * Read a memory's evolved utility weight. Returns `fallback` (default 1.0,
 * recall-neutral) when the row doesn't exist yet.
 */
export function getMemoryWeight(
  db: Database,
  entityKey: string,
  fallback = 1.0,
): number {
  const row = db
    .prepare("SELECT weight FROM citation_counts WHERE entity_key = ?")
    .get(entityKey) as { weight: number | null } | null;
  if (!row || row.weight === null || !Number.isFinite(row.weight)) return fallback;
  return row.weight;
}

/** Batch-read weights for many keys (recall hot path). Missing → fallback. */
export function getMemoryWeights(
  db: Database,
  entityKeys: readonly string[],
  fallback = 1.0,
): Map<string, number> {
  const out = new Map<string, number>();
  if (entityKeys.length === 0) return out;
  const stmt = db.prepare("SELECT weight FROM citation_counts WHERE entity_key = ?");
  for (const k of entityKeys) {
    const row = stmt.get(k) as { weight: number | null } | null;
    out.set(k, row && row.weight !== null && Number.isFinite(row.weight) ? row.weight : fallback);
  }
  return out;
}

/**
 * Persist an evolved weight. Upserts the row so a never-cited memory can be
 * weighted before its first citation_counts insert (defensive).
 */
export function setMemoryWeight(
  db: Database,
  entityKey: string,
  weight: number,
  nowMs: number,
): void {
  db.prepare(
    "INSERT INTO citation_counts (entity_key, count, distinct_sessions, last_cited_ms, weight, last_weight_ms) " +
      "VALUES (?, 0, 0, ?, ?, ?) " +
      "ON CONFLICT(entity_key) DO UPDATE SET weight = excluded.weight, last_weight_ms = excluded.last_weight_ms",
  ).run(entityKey, nowMs, weight, nowMs);
}

/**
 * Phase 12 migration: ensure `entities.payload_hash` exists and is populated
 * for any row that has a payload. Idempotent. Cheap on databases that have
 * already been migrated (one PRAGMA call + an indexed scan).
 */
function migrateAddPayloadHash(db: Database): void {
  const cols = db.prepare("PRAGMA table_info(entities)").all() as Array<{
    name: string;
  }>;
  const hasColumn = cols.some((c) => c.name === "payload_hash");
  if (!hasColumn) {
    db.exec("ALTER TABLE entities ADD COLUMN payload_hash TEXT;");
  }
  // Backfill: find rows with payload but no hash, compute, update.
  // Excludes state_root entities (Phase 13) — they're meta-commitments TO the
  // MMR and including them would cause recursion.
  const missing = db
    .prepare(
      "SELECT entity_key, payload, attributes_json FROM entities " +
        "WHERE payload_hash IS NULL AND payload IS NOT NULL",
    )
    .all() as Array<{
    entity_key: string;
    payload: Uint8Array | null;
    attributes_json: string | null;
  }>;
  if (missing.length === 0) return;
  const update = db.prepare(
    "UPDATE entities SET payload_hash = ? WHERE entity_key = ?",
  );
  for (const row of missing) {
    if (!row.payload || row.payload.byteLength === 0) continue;
    // Skip state_root entities — see header comment.
    if (row.attributes_json) {
      try {
        const attrs = JSON.parse(row.attributes_json) as Array<{
          key: string;
          value: string | number;
        }>;
        const entityType = attrs.find((a) => a.key === "entityType")?.value;
        if (entityType === "state_root") continue;
      } catch {
        /* malformed JSON — proceed with hashing */
      }
    }
    const hashHex = bytesToHex(keccak256(row.payload, "bytes"));
    update.run(hashHex, row.entity_key);
  }
}

export function closeMirrorDb(): void {
  if (_db) {
    _db.close();
    _db = undefined;
  }
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export type EventType =
  | "created"
  | "updated"
  | "extended"
  | "deleted"
  | "expired"
  | "owner_changed";

export type EntityState = "live" | "deleted" | "expired";

export interface EntityRow {
  entity_key: Hex;
  owner: Hex;
  creator: Hex | null;
  content_type: string | null;
  payload: Uint8Array | null;
  attributes_json: string | null;
  expires_at_block: number;
  created_at_block: number | null;
  last_modified_at_block: number | null;
  state: EntityState;
  first_seen_block: number;
  last_event_block: number;
  last_event_type: EventType;
  hydrated_at_ms: number | null;
  payload_hash: Hex | null;
}

/** Phase 12 — MMR state-root commits. */
export interface StateRootRow {
  id: number;
  root_hex: Hex;
  leaf_count: number;
  computed_at_ms: number;
  trigger_reason: "manual" | "act" | "periodic" | "boot";
  anchored_tx_hash: Hex | null;
  anchored_at_block: number | null;
  anchored_at_ms: number | null;
  anchored_entity_key: Hex | null;
}

export interface EventRow {
  id: number;
  block_number: number;
  tx_hash: Hex | null;
  log_index: number | null;
  event_type: EventType;
  entity_key: Hex;
  owner: Hex | null;
  old_owner: Hex | null;
  new_owner: Hex | null;
  old_expiration_block: number | null;
  new_expiration_block: number | null;
  cost: string | null;
  observed_at_ms: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function decodeAttributes(json: string | null): Attribute[] {
  if (!json) return [];
  return JSON.parse(json) as Attribute[];
}

export function encodeAttributes(attrs: readonly Attribute[]): string {
  return JSON.stringify(attrs);
}

// ---------------------------------------------------------------------------
// Daemon state (resume cursor, etc.)
// ---------------------------------------------------------------------------

export function getDaemonState(db: Database, key: string): string | null {
  const row = db
    .prepare("SELECT value FROM daemon_state WHERE key = ?")
    .get(key) as { value: string } | null;
  return row?.value ?? null;
}

export function setDaemonState(db: Database, key: string, value: string): void {
  db.prepare(
    "INSERT INTO daemon_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

// ---------------------------------------------------------------------------
// Membership cache (Cortex vs cross-project)
// ---------------------------------------------------------------------------

export function getMembership(db: Database, entityKey: Hex): boolean | null {
  const row = db
    .prepare("SELECT in_project FROM entity_membership WHERE entity_key = ?")
    .get(entityKey) as { in_project: number } | null;
  if (!row) return null;
  return row.in_project === 1;
}

export function setMembership(db: Database, entityKey: Hex, inProject: boolean): void {
  db.prepare(
    "INSERT INTO entity_membership (entity_key, in_project, checked_at_ms) VALUES (?, ?, ?) " +
      "ON CONFLICT(entity_key) DO UPDATE SET in_project = excluded.in_project, checked_at_ms = excluded.checked_at_ms",
  ).run(entityKey, inProject ? 1 : 0, Date.now());
}

// ---------------------------------------------------------------------------
// Synaptic Market — persisted listing decryption keys
// ---------------------------------------------------------------------------

export interface ListingKeyRow {
  entityKey: Hex;
  sealed: Uint8Array;
  nonce: Uint8Array;
}

/**
 * Persist a per-listing decryption key. The caller MUST have already sealed
 * it under the user-derived payload key — we do not handle plaintext keys
 * here. `sealed` is the AES-GCM ciphertext+tag and `nonce` is the 12-byte
 * IV that was used to seal it.
 *
 * Idempotent — re-publishing under the same entityKey replaces the row.
 */
export function saveListingKey(
  db: Database,
  entityKey: Hex,
  sealed: Uint8Array,
  nonce: Uint8Array,
): void {
  db.prepare(
    "INSERT INTO listing_keys (entity_key, decryption_key_sealed, nonce, created_at_ms) " +
      "VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(entity_key) DO UPDATE SET " +
      "decryption_key_sealed = excluded.decryption_key_sealed, " +
      "nonce = excluded.nonce, " +
      "created_at_ms = excluded.created_at_ms",
  ).run(entityKey, sealed, nonce, Date.now());
}

/**
 * Load every persisted listing key. The grant-watcher daemon calls this on
 * boot to rehydrate its in-memory keyMap so it can fulfil Grant events for
 * listings published before the last restart.
 *
 * Returns sealed ciphertext + nonce — the caller is responsible for
 * unsealing each row with the user-derived key.
 */
export function loadAllListingKeys(db: Database): ListingKeyRow[] {
  const rows = db
    .prepare(
      "SELECT entity_key, decryption_key_sealed, nonce FROM listing_keys",
    )
    .all() as Array<{
    entity_key: string;
    decryption_key_sealed: Uint8Array;
    nonce: Uint8Array;
  }>;
  return rows.map((r) => ({
    entityKey: r.entity_key as Hex,
    sealed: new Uint8Array(r.decryption_key_sealed),
    nonce: new Uint8Array(r.nonce),
  }));
}

// ---------------------------------------------------------------------------
// Agent Allowance helpers (Phase 11)
// ---------------------------------------------------------------------------

export type AllowanceState = "active" | "exhausted" | "expired" | "paused";

export interface AllowanceRow {
  sessionKey: Hex;
  master: Hex;
  scope: Hex;
  entityNamespace: Hex;
  maxWrites: number;
  /** Stored as decimal string in SQLite; surfaced here as bigint. */
  maxGasWei: bigint;
  refillThresholdWei: bigint;
  estimatedDailyCostWei: bigint;
  spentWei: bigint;
  writeCount: number;
  validAfter: number;
  validBefore: number;
  nonce: Hex;
  /** Effective state — computed live, not just whatever the column holds. */
  state: AllowanceState;
  /** Raw stored state, in case the caller wants to inspect the persisted hint. */
  storedState: AllowanceState;
  createdAtMs: number;
  lastSpendAtMs: number | null;
  refilledFrom: Hex | null;
}

export interface SpendRow {
  id: number;
  sessionKey: Hex;
  txHash: Hex | null;
  gasWei: bigint;
  writeCountDelta: number;
  atMs: number;
}

/**
 * Compute the effective state of an allowance from its persisted columns.
 * State precedence (highest first):
 *   1. paused — explicit override, never auto-flipped back
 *   2. expired — explicit (refill flow) OR `now > valid_before`
 *   3. exhausted — explicit OR `spent >= max_gas_wei` OR `write_count >= max_writes`
 *   4. active
 *
 * Note: terminal states persisted in the column (`paused`, `expired`,
 * `exhausted`) are sticky — once flipped, the lazy compute never relaxes
 * them back to `active`. Refilling creates a *new* row rather than reusing
 * the old session key.
 */
function computeAllowanceState(
  storedState: AllowanceState,
  spentWei: bigint,
  maxGasWei: bigint,
  writeCount: number,
  maxWrites: number,
  validBefore: number,
  nowSeconds: number,
): AllowanceState {
  if (storedState === "paused") return "paused";
  if (storedState === "expired") return "expired";
  if (nowSeconds > validBefore) return "expired";
  if (storedState === "exhausted") return "exhausted";
  if (spentWei >= maxGasWei) return "exhausted";
  if (writeCount >= maxWrites) return "exhausted";
  return "active";
}

interface RawAllowanceRow {
  session_key: string;
  master: string;
  scope: string;
  entity_namespace: string;
  max_writes: number;
  max_gas_wei: string;
  refill_threshold_wei: string;
  estimated_daily_cost_wei: string;
  spent_wei: string;
  write_count: number;
  valid_after: number;
  valid_before: number;
  nonce: string;
  state: string;
  created_at_ms: number;
  last_spend_at_ms: number | null;
  refilled_from: string | null;
}

function rowToAllowance(r: RawAllowanceRow): AllowanceRow {
  const storedState = (r.state as AllowanceState) ?? "active";
  const spentWei = BigInt(r.spent_wei);
  const maxGasWei = BigInt(r.max_gas_wei);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const state = computeAllowanceState(
    storedState,
    spentWei,
    maxGasWei,
    r.write_count,
    r.max_writes,
    r.valid_before,
    nowSeconds,
  );
  return {
    sessionKey: r.session_key as Hex,
    master: r.master as Hex,
    scope: r.scope as Hex,
    entityNamespace: r.entity_namespace as Hex,
    maxWrites: r.max_writes,
    maxGasWei,
    refillThresholdWei: BigInt(r.refill_threshold_wei),
    estimatedDailyCostWei: BigInt(r.estimated_daily_cost_wei),
    spentWei,
    writeCount: r.write_count,
    validAfter: r.valid_after,
    validBefore: r.valid_before,
    nonce: r.nonce as Hex,
    state,
    storedState,
    createdAtMs: r.created_at_ms,
    lastSpendAtMs: r.last_spend_at_ms,
    refilledFrom: (r.refilled_from as Hex | null) ?? null,
  };
}

/**
 * Verify the master's V2 signature, then persist the allowance row. Idempotent
 * on `(session_key)` collision — the caller should treat a re-insert of the
 * same session_key as a no-op and re-read via `getAllowanceBySessionKey`.
 *
 * Returns the freshly inserted (or pre-existing) row.
 *
 * Throws if:
 *   - signature does not verify against `auth.user`
 *   - `signer` does not match `auth.user` (case-insensitive)
 *   - `auth.maxGasWei <= 0n`
 *   - `auth.maxWrites <= 0n`
 */
export async function createAllowance(
  db: Database,
  auth: SessionAuthorizationV2,
  signature: Hex,
  signer: Hex,
  options?: { refilledFrom?: Hex },
): Promise<AllowanceRow> {
  // Surface-level guards first — these are cheap, fail fast.
  if (auth.maxGasWei <= 0n) {
    throw new Error("createAllowance: auth.maxGasWei must be > 0");
  }
  if (auth.maxWrites <= 0n) {
    throw new Error("createAllowance: auth.maxWrites must be > 0");
  }
  if (normaliseAddress(signer) !== normaliseAddress(auth.user)) {
    throw new Error("createAllowance: signer does not match auth.user");
  }

  const ok = await verifySessionAuthorizationV2(auth, signature);
  if (!ok) {
    throw new Error("createAllowance: signature did not verify");
  }

  const existing = getAllowanceBySessionKey(db, auth.sessionKey);
  if (existing) return existing;

  const now = Date.now();
  db.prepare(
    `INSERT INTO agent_allowances (
       session_key, master, scope, entity_namespace,
       max_writes, max_gas_wei, refill_threshold_wei, estimated_daily_cost_wei,
       spent_wei, write_count,
       valid_after, valid_before, nonce, state,
       created_at_ms, last_spend_at_ms, refilled_from
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '0', 0, ?, ?, ?, 'active', ?, NULL, ?)`,
  ).run(
    normaliseAddress(auth.sessionKey),
    normaliseAddress(auth.user),
    auth.scope,
    auth.entityNamespace,
    Number(auth.maxWrites),
    auth.maxGasWei.toString(),
    auth.refillThresholdWei.toString(),
    auth.estimatedDailyCostWei.toString(),
    Number(auth.validAfter),
    Number(auth.validBefore),
    auth.nonce,
    now,
    options?.refilledFrom ? normaliseAddress(options.refilledFrom) : null,
  );

  const row = getAllowanceBySessionKey(db, auth.sessionKey);
  if (!row) {
    throw new Error("createAllowance: insert succeeded but row not found");
  }
  return row;
}

export function getAllowanceBySessionKey(
  db: Database,
  sessionKey: Hex,
): AllowanceRow | null {
  const row = db
    .prepare("SELECT * FROM agent_allowances WHERE session_key = ?")
    .get(normaliseAddress(sessionKey)) as RawAllowanceRow | null;
  return row ? rowToAllowance(row) : null;
}

export function getAllowancesByMaster(
  db: Database,
  masterAddr: Hex,
): AllowanceRow[] {
  const rows = db
    .prepare(
      "SELECT * FROM agent_allowances WHERE master = ? ORDER BY created_at_ms DESC",
    )
    .all(normaliseAddress(masterAddr)) as RawAllowanceRow[];
  return rows.map(rowToAllowance);
}

/**
 * Increment spent_wei + write_count atomically. Returns false (and writes
 * nothing) when applying the spend would push the allowance past its
 * cap — the caller should surface that as 402 Payment Required.
 *
 * Also flips `state` to `exhausted` once the cap is exactly reached, so
 * the dashboard doesn't have to call computeAllowanceState repeatedly.
 */
export function recordSpend(
  db: Database,
  sessionKey: Hex,
  txHash: Hex | null,
  gasWei: bigint,
): boolean {
  if (gasWei < 0n) {
    throw new Error("recordSpend: gasWei must be >= 0");
  }
  const sk = normaliseAddress(sessionKey);
  const existing = getAllowanceBySessionKey(db, sk);
  if (!existing) return false;

  // If the allowance is already in a terminal state, refuse.
  if (existing.state !== "active") return false;

  const nextSpent = existing.spentWei + gasWei;
  const nextWrites = existing.writeCount + 1;
  if (nextSpent > existing.maxGasWei) return false;
  if (nextWrites > existing.maxWrites) return false;

  const now = Date.now();
  const nextState: AllowanceState =
    nextSpent >= existing.maxGasWei || nextWrites >= existing.maxWrites
      ? "exhausted"
      : "active";

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE agent_allowances
         SET spent_wei = ?, write_count = ?, last_spend_at_ms = ?, state = ?
         WHERE session_key = ?`,
    ).run(nextSpent.toString(), nextWrites, now, nextState, sk);
    db.prepare(
      `INSERT INTO allowance_spends (session_key, tx_hash, gas_wei, write_count_delta, at_ms)
         VALUES (?, ?, ?, 1, ?)`,
    ).run(sk, txHash, gasWei.toString(), now);
  });
  tx();
  return true;
}

/** Force-flip an allowance to exhausted. Idempotent. */
export function markExhausted(db: Database, sessionKey: Hex): void {
  db.prepare(
    "UPDATE agent_allowances SET state = 'exhausted' WHERE session_key = ?",
  ).run(normaliseAddress(sessionKey));
}

/** Force-flip an allowance to expired. Idempotent. */
export function markExpired(db: Database, sessionKey: Hex): void {
  db.prepare(
    "UPDATE agent_allowances SET state = 'expired' WHERE session_key = ?",
  ).run(normaliseAddress(sessionKey));
}

/** Force-flip an allowance to paused (master can resume by refill). */
export function markPaused(db: Database, sessionKey: Hex): void {
  db.prepare(
    "UPDATE agent_allowances SET state = 'paused' WHERE session_key = ?",
  ).run(normaliseAddress(sessionKey));
}

export function recentSpends(
  db: Database,
  sessionKey: Hex,
  limit: number,
): SpendRow[] {
  const cap = Math.max(1, Math.min(100, Math.floor(limit)));
  const rows = db
    .prepare(
      "SELECT id, session_key, tx_hash, gas_wei, write_count_delta, at_ms FROM allowance_spends " +
        "WHERE session_key = ? ORDER BY at_ms DESC, id DESC LIMIT ?",
    )
    .all(normaliseAddress(sessionKey), cap) as Array<{
    id: number;
    session_key: string;
    tx_hash: string | null;
    gas_wei: string;
    write_count_delta: number;
    at_ms: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    sessionKey: r.session_key as Hex,
    txHash: (r.tx_hash as Hex | null) ?? null,
    gasWei: BigInt(r.gas_wei),
    writeCountDelta: r.write_count_delta,
    atMs: r.at_ms,
  }));
}

// ===========================================================================
// Phase 12 — Merkleized Memory: payload-hash readback + state-root commits
// ===========================================================================

/**
 * List every entity's payload_hash in canonical MMR insertion order:
 * created_at_block ASC, tiebroken by entity_key ASC. This is what the daemon
 * uses on boot to rebuild the in-memory MMR from scratch.
 *
 * Entities without a payload_hash (e.g. observed via event but never hydrated)
 * are skipped — they don't have a committed payload to anchor.
 */
export function listLeafHashesInOrder(
  db: Database,
): Array<{ entityKey: Hex; payloadHash: Hex }> {
  const rows = db
    .prepare(
      "SELECT entity_key, payload_hash FROM entities " +
        "WHERE payload_hash IS NOT NULL " +
        "ORDER BY COALESCE(created_at_block, first_seen_block) ASC, entity_key ASC",
    )
    .all() as Array<{ entity_key: string; payload_hash: string }>;
  return rows.map((r) => ({
    entityKey: r.entity_key as Hex,
    payloadHash: r.payload_hash as Hex,
  }));
}

/**
 * Persist payload_hash for an entity. Idempotent on (entity_key) — same hash
 * for the same payload yields a no-op UPDATE. Used by hydrateEntity in the
 * mirror daemon when it lazily computes hashes.
 */
export function setPayloadHash(
  db: Database,
  entityKey: Hex,
  payloadHash: Hex,
): void {
  db.prepare("UPDATE entities SET payload_hash = ? WHERE entity_key = ?").run(
    payloadHash,
    entityKey,
  );
}

/** Insert a new state-root commit row. Returns the inserted row's id. */
export function insertStateRoot(
  db: Database,
  args: {
    rootHex: Hex;
    leafCount: number;
    triggerReason: "manual" | "act" | "periodic" | "boot";
  },
): number {
  const res = db
    .prepare(
      "INSERT INTO state_roots (root_hex, leaf_count, computed_at_ms, trigger_reason) " +
        "VALUES (?, ?, ?, ?)",
    )
    .run(args.rootHex, args.leafCount, Date.now(), args.triggerReason);
  return Number(res.lastInsertRowid);
}

/** Mark a state_root as anchored on Arkiv. Phase 13 will call this. */
export function markStateRootAnchored(
  db: Database,
  rootHex: Hex,
  args: {
    txHash: Hex;
    blockNumber: number;
    entityKey: Hex;
  },
): void {
  db.prepare(
    "UPDATE state_roots SET anchored_tx_hash = ?, anchored_at_block = ?, anchored_at_ms = ?, anchored_entity_key = ? " +
      "WHERE root_hex = ?",
  ).run(args.txHash, args.blockNumber, Date.now(), args.entityKey, rootHex);
}

export function listRecentStateRoots(db: Database, limit = 50): StateRootRow[] {
  const rows = db
    .prepare(
      "SELECT id, root_hex, leaf_count, computed_at_ms, trigger_reason, " +
        "anchored_tx_hash, anchored_at_block, anchored_at_ms, anchored_entity_key " +
        "FROM state_roots ORDER BY id DESC LIMIT ?",
    )
    .all(Math.max(1, Math.min(500, Math.floor(limit)))) as Array<{
    id: number;
    root_hex: string;
    leaf_count: number;
    computed_at_ms: number;
    trigger_reason: string;
    anchored_tx_hash: string | null;
    anchored_at_block: number | null;
    anchored_at_ms: number | null;
    anchored_entity_key: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    root_hex: r.root_hex as Hex,
    leaf_count: r.leaf_count,
    computed_at_ms: r.computed_at_ms,
    trigger_reason: r.trigger_reason as StateRootRow["trigger_reason"],
    anchored_tx_hash: r.anchored_tx_hash as Hex | null,
    anchored_at_block: r.anchored_at_block,
    anchored_at_ms: r.anchored_at_ms,
    anchored_entity_key: r.anchored_entity_key as Hex | null,
  }));
}
