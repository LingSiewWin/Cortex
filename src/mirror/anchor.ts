/**
 * Cortex — MMR state-root anchor (Phase 13).
 *
 * Bridges the local Merkle Mountain Range to Arkiv. Two paths:
 *
 *   1. Pure write: `writeStateRootEntity(rootHex, leafCount, triggerReason)`
 *      builds and submits a `state_root` Cortex entity. Used by act() inline.
 *
 *   2. Catch-up: `anchorPendingStateRoot()` finds the most recent
 *      `state_roots` row whose `anchored_tx_hash` is NULL and broadcasts it
 *      to Arkiv. Used by the /api/state/anchor endpoint for manual flushing.
 *
 * State_root entities are LOAD-BEARING but explicitly excluded from the MMR
 * itself (the daemon's hydrate hook checks entityType and skips). Including
 * a state_root in the MMR would cause infinite recursion: every anchor would
 * change the root, requiring another anchor, ad infinitum.
 *
 * Anchor cadence: per CLAUDE.md and the Phase 11/12 brainstorms, agents
 * commit on every act() decision. This module is decoupled from that loop —
 * the caller decides WHEN to anchor, this module just does the write.
 */

import type { Hex } from "@arkiv-network/sdk";
import { jsonToPayload, ExpirationTime } from "@arkiv-network/sdk/utils";
import { singleCreate } from "../lib/batch-writer";
import { ENTITY_TYPE } from "../constants";
import { initMirrorDb, listRecentStateRoots, markStateRootAnchored } from "./db";
import { getStateMMR } from "./state";

export interface StateRootAnchorResult {
  rootHex: Hex;
  leafCount: number;
  triggerReason: "manual" | "act" | "periodic" | "boot";
  entityKey: Hex;
  txHash: Hex;
  alreadyAnchored: boolean;
}

/**
 * Build + submit a state_root Cortex entity for the given root. After the
 * tx confirms, mark the local state_roots row as anchored. Idempotent on
 * (rootHex): if the row is already anchored, returns the existing record
 * with `alreadyAnchored: true`.
 *
 * The state_root entity's PROJECT_ATTRIBUTE is stamped by singleCreate via
 * stampProjectAttribute, so the entity is discoverable via the standard
 * cortexQuery path.
 */
export async function writeStateRootEntity(opts: {
  rootHex: Hex;
  leafCount: number;
  triggerReason: "manual" | "act" | "periodic" | "boot";
  /** Optional — if set, used to update the existing state_roots row. */
  expiresInSeconds?: number;
}): Promise<StateRootAnchorResult> {
  const db = await initMirrorDb();

  // Idempotency check — has this root already been anchored?
  const existing = db
    .prepare(
      "SELECT root_hex, leaf_count, trigger_reason, anchored_tx_hash, anchored_entity_key " +
        "FROM state_roots WHERE root_hex = ?",
    )
    .get(opts.rootHex) as
    | {
        root_hex: string;
        leaf_count: number;
        trigger_reason: string;
        anchored_tx_hash: string | null;
        anchored_entity_key: string | null;
      }
    | null;

  if (existing?.anchored_tx_hash && existing.anchored_entity_key) {
    return {
      rootHex: existing.root_hex as Hex,
      leafCount: existing.leaf_count,
      triggerReason: existing.trigger_reason as StateRootAnchorResult["triggerReason"],
      entityKey: existing.anchored_entity_key as Hex,
      txHash: existing.anchored_tx_hash as Hex,
      alreadyAnchored: true,
    };
  }

  // Build the entity. Payload is JSON for self-describing verifiability —
  // anyone scanning the chain can read this entity and reconstruct what the
  // agent's mirror should look like at that point in time.
  const committedAtMs = Date.now();
  const { entityKey, txHash } = await singleCreate({
    payload: jsonToPayload({
      rootHex: opts.rootHex,
      leafCount: opts.leafCount,
      triggerReason: opts.triggerReason,
      committedAtMs,
      // Schema version — bump if we change the payload shape.
      version: 1,
    }),
    contentType: "application/json",
    attributes: [
      { key: "entityType", value: ENTITY_TYPE.STATE_ROOT },
      { key: "rootHex", value: opts.rootHex },
      { key: "leafCount", value: opts.leafCount },
      { key: "triggerReason", value: opts.triggerReason },
      { key: "committedAtMs", value: committedAtMs },
    ],
    // State roots ARE the proof of history. Long-lived so verifiers can
    // always look up "what was the committed root at block X?". Capped per
    // CLAUDE.md fee-defense at 1 year.
    expiresInSeconds:
      opts.expiresInSeconds ?? ExpirationTime.fromDays(365),
  });

  // Mark anchored — we use the chain's tx confirmation block when available,
  // but for v1 we just record the local snapshot.
  markStateRootAnchored(db, opts.rootHex, {
    txHash: txHash as Hex,
    blockNumber: 0, // Phase 13.1 will look this up via tx receipt; not blocking
    entityKey: entityKey,
  });

  return {
    rootHex: opts.rootHex,
    leafCount: opts.leafCount,
    triggerReason: opts.triggerReason,
    entityKey,
    txHash: txHash as Hex,
    alreadyAnchored: false,
  };
}

/**
 * Find the most recent state_roots row with no anchor and broadcast it.
 * Returns null if there's nothing to anchor (everything is current).
 *
 * Used by /api/state/anchor for manual flushing AND by the agent's act()
 * flow when the synchronous-inline anchor strategy is preferred.
 */
export async function anchorPendingStateRoot(): Promise<StateRootAnchorResult | null> {
  const db = await initMirrorDb();
  // Find the latest unanchored row. We pull the latest because we only need
  // one root to prove the current state — older roots are historical.
  const pending = db
    .prepare(
      "SELECT root_hex, leaf_count, trigger_reason FROM state_roots " +
        "WHERE anchored_tx_hash IS NULL ORDER BY id DESC LIMIT 1",
    )
    .get() as
    | { root_hex: string; leaf_count: number; trigger_reason: string }
    | null;

  if (!pending) return null;

  return writeStateRootEntity({
    rootHex: pending.root_hex as Hex,
    leafCount: pending.leaf_count,
    triggerReason: pending.trigger_reason as StateRootAnchorResult["triggerReason"],
  });
}

/**
 * Convenience: snapshot the current MMR root, persist the row, and anchor
 * to Arkiv in one call. This is the "commit and broadcast" primitive the
 * agent's act() loop wants.
 */
export async function commitAndAnchor(
  triggerReason: "manual" | "act" | "periodic" | "boot",
): Promise<StateRootAnchorResult> {
  const mmr = await getStateMMR();
  const rootHex = mmr.getRootHex();
  const leafCount = mmr.size();

  // Insert a row locally first so we have a record even if the chain write fails.
  // commitStateRoot is idempotent on root_hex (UNIQUE constraint) so a duplicate
  // commit for the same root is a no-op insert + returns existing id.
  const { commitStateRoot } = await import("./state");
  await commitStateRoot(triggerReason);

  return writeStateRootEntity({ rootHex, leafCount, triggerReason });
}
