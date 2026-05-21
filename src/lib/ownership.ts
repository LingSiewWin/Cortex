/**
 * Cortex — hierarchical ownership helpers.
 *
 * Solves Flaw B from docs/discussion2 ("session-key ownership breaks Darwinian engine"):
 *
 *   Working tier (1h):     $creator = $owner = sessionKey
 *                          → if session dies, memory decays. Biologically correct.
 *
 *   Episodic tier (7d):    on promotion → changeOwnership(sessionKey → userEOA)
 *                          → user controls long-term extends, attribution stays
 *                            tamper-proof via $creator.
 *
 *   Semantic tier (1y):    same as Episodic. Created by distillation cron, then
 *                          ownership transferred to userEOA.
 *
 * `changeOwnership` is a separate Arkiv op type and must be sent by the CURRENT
 * owner. At creation time the current owner is the session key, so the session
 * key can self-sign the transfer to the user EOA without needing a user
 * signature for the transfer itself (the user's authorization is the prior
 * EIP-712 SessionAuthorization).
 *
 * Why this is correct per docs/Arkiv.md §1.5 and §3.1:
 *   - The chain only checks `msg.sender == c.owner` (Entity.requireOwner)
 *   - Creator is set once at create-time, never changes (per arkiv-contracts/Entity.sol)
 *   - Section 12 of arkiv-best-practices: filter by `.createdBy(SESSION_KEY)` to
 *     reject any injection from other projects that copies PROJECT_ATTRIBUTE
 */

import type { Hash, Hex } from "@arkiv-network/sdk";
import { getWalletClient } from "./arkiv-client";
import { withRetry } from "./errors";

export interface PromoteOwnershipResult {
  txHash: Hash;
  ownershipChanged: Hex[];
}

/**
 * Transfer ownership of one or more entities from the current session-key EOA
 * to the user's primary EOA. Use at every tier promotion (working → episodic,
 * episodic → semantic).
 *
 * The session key is the `msg.sender` here; it can only transfer entities it
 * currently owns. Any entity in `entityKeys` that the session key doesn't own
 * will cause the whole batch to revert per Arkiv's atomic mutateEntities semantics.
 */
export async function promoteOwnership(
  entityKeys: readonly Hex[],
  userPrimaryEOA: Hex,
): Promise<PromoteOwnershipResult> {
  if (entityKeys.length === 0) {
    throw new Error("promoteOwnership called with empty entityKeys");
  }

  // SDK quirk: mutateEntities throws "No operations to perform" when only
  // ownershipChanges are supplied (its precondition guard omits that field).
  // We call changeOwnership per entity instead — it doesn't have the bad guard.
  // Trade-off: N txs instead of 1. Acceptable at v1 scale (a few promotions
  // per session). Bundle with creates/extends when both are present.
  const wallet = getWalletClient();
  const changed: Hex[] = [];
  let lastTxHash: Hash | undefined;

  for (const entityKey of entityKeys) {
    const result = await withRetry(
      () => wallet.changeOwnership({ entityKey, newOwner: userPrimaryEOA }),
      { label: `changeOwnership(${entityKey.slice(0, 10)}…)` },
    );
    changed.push(result.entityKey);
    lastTxHash = result.txHash as Hash;
  }

  if (!lastTxHash) {
    throw new Error("promoteOwnership: no transactions produced");
  }

  return {
    txHash: lastTxHash,
    ownershipChanged: changed,
  };
}

/**
 * Bundle a list of operations with ownership changes into a SINGLE mutateEntities
 * call. Use this when you already have creates/updates/extends to send — adding
 * ownershipChanges to that batch is safe (SDK guard only fires when NO other ops
 * are present).
 */
export async function bundleWithOwnershipChange(
  ops: {
    extensions?: { entityKey: Hex; expiresIn: number }[];
    ownershipChanges: { entityKey: Hex; newOwner: Hex }[];
  },
): Promise<{ txHash: Hash }> {
  if (!ops.extensions?.length && !ops.ownershipChanges.length) {
    throw new Error("bundleWithOwnershipChange called with no operations");
  }
  if (!ops.extensions?.length) {
    // Pure ownership change → fall back to per-entity changeOwnership
    const wallet = getWalletClient();
    let lastTx: Hash | undefined;
    for (const change of ops.ownershipChanges) {
      const result = await wallet.changeOwnership(change);
      lastTx = result.txHash as Hash;
    }
    if (!lastTx) throw new Error("bundle produced no tx");
    return { txHash: lastTx };
  }
  const wallet = getWalletClient();
  const result = await wallet.mutateEntities(ops);
  return { txHash: result.txHash };
}
