/**
 * Cortex — replay layer for the SQLite mirror.
 *
 * This is the read API. Two responsibilities:
 *
 * 1. Serve "current state" queries (the hot path for the dashboard, recall, etc.)
 *    using the `entities` table maintained by daemon.ts.
 *
 * 2. Provide a full-replay rebuild from the append-only `events` table for
 *    the ERC-5169 scriptURI commitment: anyone with the public Arkiv event
 *    stream + this code can reconstruct Cortex state without trusting our backend.
 *
 * The `entities` table is a derived cache. If it disagrees with a replay, the
 * replay wins — that's the sovereignty story made concrete.
 */

import type { Database } from "./db";
import type { Hex } from "@arkiv-network/sdk";
import { initMirrorDb, decodeAttributes, type EntityRow, type EventRow } from "./db";

// ---------------------------------------------------------------------------
// Hot-path reads (use the maintained `entities` table)
// ---------------------------------------------------------------------------

export interface MirroredEntity {
  entityKey: Hex;
  owner: Hex;
  creator: Hex | null;
  contentType: string | null;
  payload: Uint8Array | null;
  attributes: { key: string; value: string | number }[];
  expiresAtBlock: number;
  createdAtBlock: number | null;
  state: "live" | "deleted" | "expired";
  lastEventBlock: number;
  lastEventType: string;
}

function rowToEntity(row: EntityRow): MirroredEntity {
  return {
    entityKey: row.entity_key,
    owner: row.owner,
    creator: row.creator,
    contentType: row.content_type,
    payload: row.payload,
    attributes: decodeAttributes(row.attributes_json),
    expiresAtBlock: row.expires_at_block,
    createdAtBlock: row.created_at_block,
    state: row.state,
    lastEventBlock: row.last_event_block,
    lastEventType: row.last_event_type,
  };
}

export async function getMirroredEntity(entityKey: Hex): Promise<MirroredEntity | null> {
  const db = await initMirrorDb();
  const row = db
    .prepare("SELECT * FROM entities WHERE entity_key = ?")
    .get(entityKey) as EntityRow | null;
  return row ? rowToEntity(row) : null;
}

export async function listMirroredEntities(filter: {
  state?: "live" | "deleted" | "expired";
  creator?: Hex;
  owner?: Hex;
  limit?: number;
}): Promise<MirroredEntity[]> {
  const db = await initMirrorDb();
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filter.state) {
    conditions.push("state = ?");
    params.push(filter.state);
  }
  if (filter.creator) {
    conditions.push("creator = ?");
    params.push(filter.creator);
  }
  if (filter.owner) {
    conditions.push("owner = ?");
    params.push(filter.owner);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filter.limit ?? 100;
  const allParams: (string | number)[] = [...params, limit];
  const rows = db
    .prepare(`SELECT * FROM entities ${where} ORDER BY last_event_block DESC LIMIT ?`)
    .all(...allParams) as EntityRow[];
  return rows.map(rowToEntity);
}

// ---------------------------------------------------------------------------
// Event log access (for replay + audit)
// ---------------------------------------------------------------------------

export async function getEventsForEntity(entityKey: Hex): Promise<EventRow[]> {
  const db = await initMirrorDb();
  return db
    .prepare("SELECT * FROM events WHERE entity_key = ? ORDER BY block_number ASC, log_index ASC")
    .all(entityKey) as EventRow[];
}

export async function getEventsInBlockRange(
  fromBlock: number,
  toBlock: number,
): Promise<EventRow[]> {
  const db = await initMirrorDb();
  return db
    .prepare(
      "SELECT * FROM events WHERE block_number BETWEEN ? AND ? ORDER BY block_number ASC, log_index ASC",
    )
    .all(fromBlock, toBlock) as EventRow[];
}

// ---------------------------------------------------------------------------
// Full replay — reconstruct entity state from the event log alone.
//
// Used by:
//   1. Self-host script (ERC-5169): "rebuild your view of Cortex from raw chain events"
//   2. Integrity audit: replay should match the maintained `entities` table for
//      any entity the daemon is tracking
//
// This does NOT call getEntity — payload + attribute info is only available on
// the live chain (or via re-running the daemon's hydrate path). Replay focuses
// on the event-derivable fields: owner, expirationBlock, state.
// ---------------------------------------------------------------------------

export interface ReplayedEntity {
  entityKey: Hex;
  owner: Hex | null;
  expiresAtBlock: number | null;
  state: "live" | "deleted" | "expired";
  events: EventRow[];
}

export async function replayEntity(entityKey: Hex): Promise<ReplayedEntity | null> {
  const events = await getEventsForEntity(entityKey);
  if (events.length === 0) return null;

  let owner: Hex | null = null;
  let expiresAtBlock: number | null = null;
  let state: "live" | "deleted" | "expired" = "live";

  for (const ev of events) {
    switch (ev.event_type) {
      case "created":
        owner = ev.owner;
        expiresAtBlock = ev.new_expiration_block;
        state = "live";
        break;
      case "updated":
      case "extended":
        if (ev.owner) owner = ev.owner;
        if (ev.new_expiration_block !== null) expiresAtBlock = ev.new_expiration_block;
        break;
      case "owner_changed":
        if (ev.new_owner) owner = ev.new_owner;
        break;
      case "deleted":
        state = "deleted";
        break;
      case "expired":
        state = "expired";
        break;
    }
  }

  return { entityKey, owner, expiresAtBlock, state, events };
}
