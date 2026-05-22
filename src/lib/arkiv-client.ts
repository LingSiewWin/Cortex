/**
 * Cortex — Arkiv client wrappers.
 *
 * Two singletons (lazy-initialised):
 *   - publicClient (read): used by mirror daemon, query helpers, dashboard
 *   - walletClient (write): used by the session-key relayer for create/update/extend
 *
 * Every entity created here is stamped with PROJECT_ATTRIBUTE. Every query helper
 * filters by it. Forgetting this is the #1 way to leak/pollute Arkiv state — so the
 * helpers make it impossible by construction.
 *
 * SDK ground truth verified against node_modules/@arkiv-network/sdk@0.6.8 source.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  type Hex,
} from "@arkiv-network/sdk";
import { privateKeyToAccount } from "@arkiv-network/sdk/accounts";
import { braga } from "@arkiv-network/sdk/chains";
import type {
  PublicArkivClient,
  WalletArkivClient,
} from "@arkiv-network/sdk";
import type { Attribute } from "@arkiv-network/sdk/types";
import { eq } from "@arkiv-network/sdk/query";
import { PROJECT_ATTRIBUTE, BRAGA } from "../constants";
import { publish, type ArkivRpcMethod } from "./events";

// ---------------------------------------------------------------------------
// Singletons
// ---------------------------------------------------------------------------

let _publicClient: PublicArkivClient | undefined;
let _walletClient: WalletArkivClient | undefined;

/** Read-only client. Safe to use anywhere — no private key needed. */
export function getPublicClient(): PublicArkivClient {
  if (!_publicClient) {
    const customRpc = process.env.CORTEX_BRAGA_RPC;
    _publicClient = createPublicClient({
      chain: braga,
      transport: http(customRpc ?? BRAGA.httpRpc),
    });
  }
  return _publicClient;
}

/**
 * Wallet client tied to the session-key EOA. Reads SESSION_KEY_PRIVATE_KEY from env
 * (Bun auto-loads .env). Throws fast if missing — never silently degrade to read-only.
 */
export function getWalletClient(): WalletArkivClient {
  if (_walletClient) return _walletClient;

  const pk = process.env.SESSION_KEY_PRIVATE_KEY;
  if (!pk) {
    throw new Error(
      "SESSION_KEY_PRIVATE_KEY missing from environment. " +
        "Copy .env.example to .env and fund the session-key EOA via " +
        BRAGA.faucet,
    );
  }
  if (!pk.startsWith("0x") || pk.length !== 66) {
    throw new Error(
      "SESSION_KEY_PRIVATE_KEY must be a 0x-prefixed 64-hex-char string (32 bytes).",
    );
  }

  const customRpc = process.env.CORTEX_BRAGA_RPC;
  _walletClient = createWalletClient({
    chain: braga,
    transport: http(customRpc ?? BRAGA.httpRpc),
    account: privateKeyToAccount(pk as Hex),
  });
  return _walletClient;
}

/** The address of the active session-key EOA (the `$creator` for everything we write). */
export function getSessionKeyAddress(): Hex {
  const account = getWalletClient().account;
  if (!account) {
    // Unreachable: getWalletClient() throws if SESSION_KEY_PRIVATE_KEY is missing,
    // and privateKeyToAccount always returns a defined account.
    throw new Error("Wallet client has no account — internal invariant violated.");
  }
  return account.address;
}

/**
 * The user's primary EOA — the persistent `$owner` of promoted entities.
 *
 * Reads `USER_PRIMARY_ADDRESS` from env (Bun auto-loads .env). This is the
 * destination for tier-promotion ownership transfers in the Darwinian engine
 * and the buyer/seller address in the Synaptic Market. Throws clearly if
 * missing or malformed so callers fail fast instead of silently sending funds
 * or memories to the zero address.
 *
 * Per CLAUDE.md "Ownership model": `$owner = user's primary EOA` (mutable,
 * controls extend/update/delete) — the counterpart to the session-key
 * `$creator` returned by `getSessionKeyAddress()`.
 */
export function getUserPrimaryEOA(): Hex {
  const v = process.env.USER_PRIMARY_ADDRESS;
  if (!v) {
    throw new Error(
      "USER_PRIMARY_ADDRESS missing from env. See .env.example.",
    );
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) {
    throw new Error(
      "USER_PRIMARY_ADDRESS must be a 0x-prefixed 40-hex-char EOA.",
    );
  }
  return v as Hex;
}

// ---------------------------------------------------------------------------
// PROJECT_ATTRIBUTE enforcement
// ---------------------------------------------------------------------------

/**
 * Merge PROJECT_ATTRIBUTE into a user-supplied attribute list, refusing to ship
 * an entity without it. Last-writer-wins semantics on the project key — callers
 * cannot override Cortex's namespace.
 */
export function stampProjectAttribute(
  userAttributes: readonly Attribute[],
): Attribute[] {
  const filtered = userAttributes.filter(
    (a) => a.key !== PROJECT_ATTRIBUTE.key,
  );
  return [
    { key: PROJECT_ATTRIBUTE.key, value: PROJECT_ATTRIBUTE.value },
    ...filtered,
  ];
}

/**
 * Build a query that always filters by PROJECT_ATTRIBUTE.
 *
 * Trust model (arkiv-best-practices §11–12):
 *   - By DEFAULT (`createdBy` omitted), the query is narrowed to
 *     `createdBy=SESSION_KEY` so attribute-injection attacks (anyone on Braga
 *     writing entities tagged `project=cortex-ethns-2026`) cannot poison reads.
 *   - Pass `createdBy: null` for legitimate cross-creator reads — e.g. market
 *     listings, where buyers must see entities written by other sellers.
 *   - Pass `createdBy: <Hex>` to filter by an explicit creator (e.g. when
 *     auditing a peer's writes).
 *   - `ownedBy` is independent and applied if set.
 */
export function cortexQuery(options?: {
  createdBy?: Hex | null;
  ownedBy?: Hex;
}) {
  const q = getPublicClient()
    .buildQuery()
    .where(eq(PROJECT_ATTRIBUTE.key, PROJECT_ATTRIBUTE.value));
  if (options?.createdBy === null) {
    // Explicit opt-out — cross-creator read.
  } else if (options?.createdBy === undefined) {
    // Default — own-data read, filter to our session key.
    q.createdBy(getSessionKeyAddress());
  } else {
    q.createdBy(options.createdBy);
  }
  if (options?.ownedBy) q.ownedBy(options.ownedBy);
  return q;
}

/**
 * Canonical address normalization. Arkiv returns checksum-cased addresses from
 * `getEntity`/queries, but our attribute joins (cite0, listingKey, buyer, etc.)
 * store lowercase. Use this on every address compared across the two surfaces.
 */
export function normaliseAddress(addr: Hex): Hex {
  return addr.toLowerCase() as Hex;
}

// ---------------------------------------------------------------------------
// Block-relative helpers (for accumulative extend math)
// ---------------------------------------------------------------------------

/**
 * Compute seconds remaining until an entity expires, given its `expiresAtBlock`.
 * Returns 0 if already expired.
 */
export async function secondsUntilExpiry(expiresAtBlock: bigint): Promise<number> {
  const { currentBlock, blockDuration } = await getPublicClient().getBlockTiming();
  if (expiresAtBlock <= currentBlock) return 0;
  const blocksRemaining = Number(expiresAtBlock - currentBlock);
  return blocksRemaining * blockDuration;
}

// ---------------------------------------------------------------------------
// Live Spine instrumentation (Phase 16)
// ---------------------------------------------------------------------------

/**
 * Wrap an Arkiv RPC call so it emits an `arkiv.rpc.call` event on the live
 * spine — timing, byte size, tx hash. The dashboard's RPC ticker subscribes
 * to these so a judge can watch chain activity in real time.
 *
 * Used only by the PRODUCTION default code paths (batch-writer, extend). Test
 * code injects its own send/getEntity deps and never reaches this wrapper, so
 * the 143-test suite stays silent.
 *
 * Emits on both success and failure (failures show as a red bar in the ticker).
 * Never swallows the error — re-throws after recording.
 */
export async function instrumentRpc<T>(
  method: ArkivRpcMethod,
  fn: () => Promise<T>,
  extract?: (result: T) => {
    byteSize?: number;
    txHash?: string;
    blockNumber?: number;
  },
): Promise<T> {
  const start = performance.now();
  try {
    const result = await fn();
    const meta = extract?.(result) ?? {};
    publish({
      type: "arkiv.rpc.call",
      ts: Date.now(),
      method,
      byteSize: meta.byteSize ?? 0,
      ms: performance.now() - start,
      ok: true,
      ...(meta.txHash !== undefined ? { txHash: meta.txHash } : {}),
      ...(meta.blockNumber !== undefined ? { blockNumber: meta.blockNumber } : {}),
    });
    return result;
  } catch (err) {
    publish({
      type: "arkiv.rpc.call",
      ts: Date.now(),
      method,
      byteSize: 0,
      ms: performance.now() - start,
      ok: false,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
