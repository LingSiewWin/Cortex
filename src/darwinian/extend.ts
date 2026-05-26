/**
 * Cortex — accumulative extend (the Darwinian reinforcement primitive).
 *
 * Deployed Braga (`arkiv-op-geth`) `extend` is ADDITIVE: `expiresAt += expiresIn`.
 * VERIFIED on-chain 2026-05-25 (docs/arkiv-network/2026-05-25-extend-semantics-VERIFIED.md,
 * tx 0x28be59…): a 500-block extend on an entity with 98 blocks remaining produced
 * exactly E0+500, not currentBlock+500. So `expiresIn` IS the net lease gain.
 *
 *     reinforcement = REINFORCEMENT_SECONDS (e.g. 24h on a working citation)
 *     extendEntity(entityKey, expiresIn: reinforcement)   // expiresAt += reinforcement
 *
 * Each citation adds exactly `reinforcement` of lifespan — frequently cited
 * memories accumulate; useless ones expire. LTP-faithful.
 *
 * HISTORY / WARNING: this previously used `remaining + reinforcement`, defending
 * against a REPLACE-with-`requireExpiryIncreased` revert. That REPLACE behavior is
 * a property of the FUTURE EntityRegistry.sol (unshipped SDK PR #64), NOT deployed
 * Braga. Under the live additive precompile, `remaining + reinforcement` double-counts
 * `remaining` and balloons leases. If/when Braga migrates to the ABI EntityRegistry,
 * the REPLACE formula must come back (branch on protocol version).
 *
 * Errors:
 *   - Already-expired entities throw `EntityAlreadyExpiredError`. Caller re-CREATEs
 *     rather than retrying — Braga auto-deletes expired entities, so extend reverts
 *     "no entity".
 */

import type { Hash, Hex } from "@arkiv-network/sdk";
import {
  getPublicClient,
  getWalletClient,
  secondsUntilExpiry,
  instrumentRpc,
} from "../lib/arkiv-client.ts";
import { withRetry } from "../lib/errors.ts";

/** Thrown when the caller asks us to reinforce a memory that's already gone. */
export class EntityAlreadyExpiredError extends Error {
  constructor(public readonly entityKey: Hex) {
    super(
      `Entity ${entityKey.slice(0, 10)}… is already expired — no extend possible. ` +
        `Re-CREATE the memory if it should live again (Arkiv has no un-evict op).`,
    );
    this.name = "EntityAlreadyExpiredError";
  }
}

/**
 * Look up the current `expiresAtBlock` for an entity via `getEntity`.
 * Pulled out for testability — tests can dependency-inject this via the second
 * arg to `reinforce`.
 */
async function fetchExpiresAtBlock(entityKey: Hex): Promise<bigint> {
  const entity = await instrumentRpc("getEntity", () =>
    getPublicClient().getEntity(entityKey),
  );
  const expiresAtBlock = entity.expiresAtBlock;
  if (expiresAtBlock === undefined) {
    throw new Error(
      `reinforce: getEntity(${entityKey.slice(0, 10)}…) returned no expiresAtBlock`,
    );
  }
  return expiresAtBlock;
}

/** Override seam for tests — see tests/darwinian-extend.test.ts. */
export interface ReinforceDeps {
  /** Returns the entity's current expiresAtBlock. Default: `getEntity` on the public client. */
  getExpiresAtBlock?: (entityKey: Hex) => Promise<bigint>;
  /** Returns remaining seconds until expiry. Default: `secondsUntilExpiry`. */
  remainingSeconds?: (expiresAtBlock: bigint) => Promise<number>;
  /** Sends the extendEntity tx. Default: wallet client `extendEntity`. */
  sendExtend?: (args: {
    entityKey: Hex;
    expiresIn: number;
  }) => Promise<{ txHash: Hash; entityKey: Hex }>;
}

/**
 * Extend an entity's lifespan by `reinforcementSeconds` while preserving its
 * existing remaining time. Returns the tx hash on success.
 *
 * Throws `EntityAlreadyExpiredError` if remaining = 0; caller should re-create
 * the memory instead.
 */
export async function reinforce(
  entityKey: Hex,
  reinforcementSeconds: number,
  deps?: ReinforceDeps,
): Promise<string> {
  if (!Number.isInteger(reinforcementSeconds) || reinforcementSeconds <= 0) {
    throw new Error(
      `reinforce: reinforcementSeconds must be a positive integer, got ${reinforcementSeconds}`,
    );
  }

  const getExpires = deps?.getExpiresAtBlock ?? fetchExpiresAtBlock;
  const remainingFn = deps?.remainingSeconds ?? secondsUntilExpiry;
  const sendExtend =
    deps?.sendExtend ??
    (async (args) => {
      const wallet = getWalletClient();
      return instrumentRpc(
        "extendEntity",
        () => wallet.extendEntity(args),
        (r) => ({ txHash: r.txHash, byteSize: 32 }),
      );
    });

  const expiresAtBlock = await getExpires(entityKey);
  const remaining = await remainingFn(expiresAtBlock);
  if (remaining <= 0) {
    // Expired entities are auto-deleted by Braga's per-block housekeeping, so an
    // extend would revert "no entity". Skip + signal re-create.
    throw new EntityAlreadyExpiredError(entityKey);
  }

  // Deployed Braga (`arkiv-op-geth`) `extend` is ADDITIVE: it does
  // `expiresAt += expiresIn` (VERIFIED on-chain — docs/arkiv-network/
  // 2026-05-25-extend-semantics-VERIFIED.md). So `expiresIn` is exactly the net
  // gain; passing `remaining + reinforcement` would double-count the remaining
  // lease and balloon lifespans. The `remaining + reinforcement` formula is only
  // correct on the FUTURE REPLACE-semantics EntityRegistry.sol (unshipped SDK PR #64).
  const result = await withRetry(
    () => sendExtend({ entityKey, expiresIn: reinforcementSeconds }),
    { label: `reinforce(${entityKey.slice(0, 10)}…, +${reinforcementSeconds}s)` },
  );
  return result.txHash;
}

/** Override seam for the batch helper. */
export interface ReinforceBatchDeps {
  getExpiresAtBlock?: (entityKey: Hex) => Promise<bigint>;
  remainingSeconds?: (expiresAtBlock: bigint) => Promise<number>;
  sendMutate?: (args: {
    extensions: { entityKey: Hex; expiresIn: number }[];
  }) => Promise<{ txHash: Hash }>;
}

/**
 * Bundle multiple accumulative extends into a single `mutateEntities` call.
 * Each item is reinforced by its own `reinforcementSeconds`, preserving its
 * own remaining lifespan. One tx, one ~29k overhead — amortized across N.
 *
 * Already-expired entities are dropped from the batch with a console warning
 * rather than aborting — the caller's `act()` loop already produced N>1
 * citations and shouldn't lose them all to a single stale memory.
 */
export async function reinforceBatch(
  items: { entityKey: Hex; reinforcementSeconds: number }[],
  deps?: ReinforceBatchDeps,
): Promise<string> {
  if (items.length === 0) {
    throw new Error("reinforceBatch called with empty items array");
  }
  const getExpires = deps?.getExpiresAtBlock ?? fetchExpiresAtBlock;
  const remainingFn = deps?.remainingSeconds ?? secondsUntilExpiry;
  const sendMutate =
    deps?.sendMutate ??
    (async (args) => {
      const wallet = getWalletClient();
      return instrumentRpc(
        "extendEntity",
        () => wallet.mutateEntities(args),
        (r) => ({ txHash: r.txHash, byteSize: args.extensions.length * 32 }),
      );
    });

  const extensions: { entityKey: Hex; expiresIn: number }[] = [];
  for (const item of items) {
    if (!Number.isInteger(item.reinforcementSeconds) || item.reinforcementSeconds <= 0) {
      throw new Error(
        `reinforceBatch: reinforcementSeconds must be positive int, got ${item.reinforcementSeconds} for ${item.entityKey}`,
      );
    }
    try {
      const expiresAtBlock = await getExpires(item.entityKey);
      const remaining = await remainingFn(expiresAtBlock);
      if (remaining <= 0) {
        console.warn(
          `reinforceBatch: skipping expired entity ${item.entityKey.slice(0, 10)}…`,
        );
        continue;
      }
      // ADDITIVE semantics (see reinforce() above): expiresIn IS the net gain.
      extensions.push({
        entityKey: item.entityKey,
        expiresIn: item.reinforcementSeconds,
      });
    } catch (err) {
      console.warn(
        `reinforceBatch: failed to fetch lifespan for ${item.entityKey.slice(0, 10)}… — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  if (extensions.length === 0) {
    throw new EntityAlreadyExpiredError(items[0]!.entityKey);
  }

  const result = await withRetry(
    () => sendMutate({ extensions }),
    { label: `reinforceBatch(n=${extensions.length})` },
  );
  return result.txHash;
}
