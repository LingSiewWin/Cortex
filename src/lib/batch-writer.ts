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
import { stampProjectAttribute, getWalletClient } from "./arkiv-client";
import { withRetry } from "./errors";

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

  const result = await withRetry(
    () => wallet.mutateEntities({ creates }),
    { label: `batchCreate(n=${items.length})` },
  );

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
