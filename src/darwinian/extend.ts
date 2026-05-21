/**
 * Cortex — accumulative extend (the Darwinian reinforcement primitive).
 *
 * Solves Flaw 1 from docs/Arkiv.md §3.1: Arkiv's `extend` is REPLACE-not-ADD.
 * The chain requires `newExpiresAt = currentBlock + expiresIn` to be strictly
 * greater than the current `expiresAtBlock`. A naive `extendEntity(entityKey,
 * { expiresIn: 24h })` reverts as soon as `remaining > 24h` — which is exactly
 * the regime Cortex wants (frequently cited memories should keep growing past
 * their starting lifespan).
 *
 * Fix (per CLAUDE.md "Accumulative extend"):
 *
 *     remaining        = secondsUntilExpiry(expiresAtBlock)
 *     reinforcement    = REINFORCEMENT_SECONDS (e.g. 24h on a working citation)
 *     new_btl_seconds  = remaining + reinforcement
 *     extendEntity(entityKey, expiresIn: new_btl_seconds)
 *
 * Because `expiresIn` is measured from the current block, the new expiry is
 * (currentBlock + remaining + reinforcement) = (currentExpiresAt + reinforcement),
 * which is strictly greater than currentExpiresAt for any positive
 * reinforcement. LTP-faithful, not REPLACE-naive.
 *
 * Errors:
 *   - Already-expired entities throw `EntityAlreadyExpiredError`. Caller's
 *     responsibility is to re-CREATE rather than blindly retry — there's no
 *     un-evicting an expired entity on Arkiv.
 *   - extend_too_short / ExpiryNotExtended reverts indicate a math bug or a
 *     concurrent extend; surfaced as-is via the error taxonomy.
 */

import type { Hash, Hex } from "@arkiv-network/sdk";
import {
  getPublicClient,
  getWalletClient,
  secondsUntilExpiry,
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
  const entity = await getPublicClient().getEntity(entityKey);
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
      return wallet.extendEntity(args);
    });

  const expiresAtBlock = await getExpires(entityKey);
  const remaining = await remainingFn(expiresAtBlock);
  if (remaining <= 0) {
    throw new EntityAlreadyExpiredError(entityKey);
  }

  // The accumulative formula: new lifespan from NOW = old remaining + reinforcement.
  // Because Arkiv's `expiresIn` is "seconds from current block", this makes the new
  // expiresAt strictly greater than the current one by exactly `reinforcementSeconds`.
  const newBtlSeconds = Math.floor(remaining) + reinforcementSeconds;

  const result = await withRetry(
    () => sendExtend({ entityKey, expiresIn: newBtlSeconds }),
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
      return wallet.mutateEntities(args);
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
      extensions.push({
        entityKey: item.entityKey,
        expiresIn: Math.floor(remaining) + item.reinforcementSeconds,
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
