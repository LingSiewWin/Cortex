/**
 * Cortex — batched writes via mutateEntities.
 *
 * Per docs/discussion2.md Founder Mode pitch + README math:
 *   "We batch N memories per Arkiv transaction, paying ~600 gas per memory
 *    instead of ~29,000."
 *
 * The honest win: amortize the ~29k flat tx overhead across many creates.
 * The SDK already does brotli-RLP under the hood — no WASM gymnastics needed
 * for v1 (per docs/CLAUDE.md Phase 0 decisions).
 *
 * Every create stamps PROJECT_ATTRIBUTE via lib/arkiv-client. Forgetting is
 * impossible by construction.
 */

import type { Hex } from "@arkiv-network/sdk";
import type { Attribute } from "@arkiv-network/sdk/types";
import { stampProjectAttribute, getWalletClient, instrumentRpc } from "./arkiv-client";
import { withRetry } from "./errors";
import { publish } from "./events";
import { sealPayload } from "./crypto";
import { requirePayloadKey } from "./payload-key";
import { ENTITY_TYPE, SEALED_CONTENT_TYPE } from "../constants";

/** Map a stamped `entityType` attribute to a Constellation tier (or undefined
 *  for non-memory entities like citation / state_root / listing / grant). */
const TIER_BY_ENTITY_TYPE: Record<string, "working" | "episodic" | "rule"> = {
  [ENTITY_TYPE.OBSERVATION]: "working",
  [ENTITY_TYPE.EPISODE]: "episodic",
  [ENTITY_TYPE.RULE]: "rule",
};

/** A single create spec — caller-supplied. PROJECT_ATTRIBUTE is added for you. */
export interface CortexCreate {
  payload: Uint8Array;
  attributes: Attribute[];
  contentType: string;
  /** Lifespan in seconds. Use ExpirationTime helpers; never raw seconds. */
  expiresInSeconds: number;
}

export interface BatchCreateResult {
  txHash: Hex;
  /** Entity keys in the same order as the input array. */
  entityKeys: Hex[];
}

/**
 * Batch many creates into one Arkiv transaction. Returns the txHash and the
 * entity keys in input order.
 *
 * Soft cap recommendation: ~50 creates per call. The op-reth ExEx loop processes
 * the whole batch atomically; very large batches risk gas-limit issues or
 * client-side memory blowup on brotli compression. Tune empirically.
 */
export async function batchCreate(items: CortexCreate[]): Promise<BatchCreateResult> {
  if (items.length === 0) {
    throw new Error("batchCreate called with empty items array");
  }

  const wallet = getWalletClient();
  const creates = items.map((item) => ({
    payload: item.payload,
    attributes: stampProjectAttribute(item.attributes),
    contentType: item.contentType,
    expiresIn: item.expiresInSeconds,
  }));

  const byteSize = items.reduce((acc, i) => acc + i.payload.byteLength, 0);
  const result = await instrumentRpc(
    "mutateEntities",
    () =>
      withRetry(() => wallet.mutateEntities({ creates }), {
        label: `batchCreate(n=${items.length})`,
      }),
    (r) => ({ txHash: r.txHash, byteSize }),
  );

  // Live spine — emit memory.created for each newly-created memory entity
  // (observation/episode/rule). Non-memory writes (citation, state_root,
  // listing, grant) are skipped so the Constellation only gets real dots.
  // expiresAtBlock is 0 here (not known until the tx mines); the dashboard's
  // /api/memories poll backfills the real value within one refresh cycle.
  for (let i = 0; i < items.length; i++) {
    const et = items[i]!.attributes.find((a) => a.key === "entityType")?.value;
    const tier = typeof et === "string" ? TIER_BY_ENTITY_TYPE[et] : undefined;
    const key = result.createdEntities[i];
    if (tier && key) {
      publish({
        type: "memory.created",
        ts: Date.now(),
        entityKey: key,
        tier,
        expiresAtBlock: 0,
      });
    }
  }

  return {
    txHash: result.txHash,
    entityKeys: result.createdEntities,
  };
}

/**
 * Convenience for the single-entity case. Still goes through mutateEntities so
 * we have consistent ownership/relayer plumbing in v2.
 */
export async function singleCreate(item: CortexCreate): Promise<{
  txHash: Hex;
  entityKey: Hex;
}> {
  const { txHash, entityKeys } = await batchCreate([item]);
  const entityKey = entityKeys[0];
  if (!entityKey) {
    throw new Error("singleCreate: mutateEntities returned no entity keys");
  }
  return { txHash, entityKey };
}

// ---------------------------------------------------------------------------
// Sealed memory writes — the encryption-at-rest chokepoint.
//
// Memory entities (observation / episode / rule) are the only payloads recall
// scores, and the only ones we encrypt: the RaBitQ/rule bytes are sealed with
// the wallet-derived key (src/lib/payload-key.ts) and stamped SEALED_CONTENT_TYPE
// so the chain holds ciphertext. recall (src/darwinian/recall.ts) decrypts in RAM
// after reading the local mirror. Non-memory writes (citation, state_root, market
// listing/grant) keep using singleCreate/batchCreate directly and stay plaintext.
//
// The original contentType is intentionally replaced by SEALED_CONTENT_TYPE; the
// `entityType` attribute (stamped by callers) remains the type-of-record.
// ---------------------------------------------------------------------------

/** Create one sealed memory entity. Throws if no wallet key is available. */
export async function createMemory(item: CortexCreate): Promise<{
  txHash: Hex;
  entityKey: Hex;
}> {
  const key = await requirePayloadKey();
  const sealed = await sealPayload(key, item.payload);
  return singleCreate({ ...item, payload: sealed, contentType: SEALED_CONTENT_TYPE });
}

/** Batch-create sealed memory entities (one tx). Throws if no wallet key is available. */
export async function createMemories(items: CortexCreate[]): Promise<BatchCreateResult> {
  if (items.length === 0) {
    throw new Error("createMemories called with empty items array");
  }
  const key = await requirePayloadKey();
  const sealedItems = await Promise.all(
    items.map(async (it) => ({
      ...it,
      payload: await sealPayload(key, it.payload),
      contentType: SEALED_CONTENT_TYPE,
    })),
  );
  return batchCreate(sealedItems);
}
