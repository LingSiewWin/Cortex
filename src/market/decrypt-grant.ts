/**
 * Cortex — Synaptic Market: discovery, purchase, and grant fulfillment.
 *
 * Three flows in one file (intentionally — they share the listing/grant
 * attribute schema and benefit from being read top-to-bottom):
 *
 *   1. browseListings — buyer-side discovery via Arkiv attribute queries.
 *      No decryption happens here; this is the "queryable public DB" pitch.
 *
 *   2. buyAndDecrypt — buyer-side end-to-end: send GLM to the SynapticMarket
 *      contract, then poll Arkiv for the grant entity the seller's relayer
 *      writes in response. Decrypt the original listing with the key carried
 *      by the grant.
 *
 *   3. startGrantWatcher — seller-side daemon. Listens for `Grant(listingKey,
 *      buyer, paidPrice, ts)` events on the SynapticMarket contract; for each
 *      hit, looks up the listing's decryption key (kept in-memory by the
 *      relayer) and writes a grant entity carrying that key, tagged with the
 *      buyer's address so the buyer can find it.
 *
 * v1 fidelity caveat: the grant entity carries the raw decryption key as its
 * payload. Anyone who can read the grant entity (the whole world, since Arkiv
 * is a public DB) can also decrypt the listing. v2 will seal the key to the
 * buyer's pubkey via ECIES; for the demo, the buyer-attribute filter is the
 * only access control. This is documented in README Trust Assumptions.
 */

import type { Hex, Address } from "@arkiv-network/sdk";
import {
  type Log,
  parseAbi,
  encodeFunctionData,
  decodeEventLog,
  toEventHash,
} from "viem";
import { eq } from "@arkiv-network/sdk/query";
import type { WalletArkivClient } from "@arkiv-network/sdk";
import type { Database } from "bun:sqlite";
import { openPayload } from "../lib/crypto";
import { singleCreate } from "../lib/batch-writer";
import {
  cortexQuery,
  getPublicClient,
  getSessionKeyAddress,
} from "../lib/arkiv-client";
import { loadAllListingKeys } from "../mirror/db";
import { ENTITY_TYPE } from "../constants";

// ---------------------------------------------------------------------------
// ABI / event topic
// ---------------------------------------------------------------------------

/**
 * Minimal ABI for SynapticMarket. We don't import the full Solidity ABI here
 * because Phase 7 owns deployment + ABI integration; we only need the function
 * selector for `buy` and the event signature for `Grant`.
 */
export const SYNAPTIC_MARKET_ABI = parseAbi([
  "function buy(bytes32 listingKey) payable",
  "function register(bytes32 listingKey, uint256 priceWei)",
  "event Grant(bytes32 indexed listingKey, address indexed buyer, uint256 paidPrice, uint256 timestamp)",
  "event ListingRegistered(bytes32 indexed listingKey, address indexed seller, uint256 priceWei)",
]);

/**
 * Standalone event-only ABI tuple for the Grant event. We feed this to
 * watchEvent via its `events:` (plural) union branch — the `event:` (singular)
 * branch needs the `abiEvent` generic to flow through at call site, which
 * isn't ergonomic when the event is defined in a separate const.
 */
const GRANT_EVENTS_ABI = parseAbi([
  "event Grant(bytes32 indexed listingKey, address indexed buyer, uint256 paidPrice, uint256 timestamp)",
] as const);

/** keccak256("Grant(bytes32,address,uint256,uint256)") */
export const GRANT_EVENT_TOPIC = toEventHash(
  "Grant(bytes32,address,uint256,uint256)",
);

// ---------------------------------------------------------------------------
// 1. Browse — buyer-side listing discovery
// ---------------------------------------------------------------------------

export interface BrowsedListing {
  entityKey: Hex;
  ruleTag: string;
  confidence: number;
  priceWei: bigint;
  seller: Hex;
}

/**
 * Query Arkiv for live listings matching a topic tag, sorted by confidence (desc).
 * Returns listing metadata only — payload stays encrypted on chain.
 */
export async function browseListings(opts: {
  ruleTag?: string;
  maxPriceWei?: bigint;
} = {}): Promise<BrowsedListing[]> {
  // Market discovery is intentionally cross-creator: buyers need to see
  // listings written by other sellers' session keys. Override the default
  // createdBy=SESSION_KEY filter.
  const builder = cortexQuery({ createdBy: null })
    .where(eq("entityType", ENTITY_TYPE.LISTING))
    .withAttributes(true)
    .withMetadata(true)
    .limit(100);

  if (opts.ruleTag) {
    builder.where(eq("ruleTag", opts.ruleTag));
  }

  const result = await builder.fetch();

  const out: BrowsedListing[] = [];
  for (const entity of result.entities) {
    const ruleTag = stringAttr(entity.attributes, "ruleTag");
    const confidence = numberAttr(entity.attributes, "confidence");
    const priceWeiStr = stringAttr(entity.attributes, "priceWei");
    const seller = stringAttr(entity.attributes, "seller");
    if (
      ruleTag === undefined ||
      confidence === undefined ||
      priceWeiStr === undefined ||
      seller === undefined
    ) {
      // Malformed listing — skip rather than throw; the public DB has noise.
      continue;
    }
    let priceWei: bigint;
    try {
      priceWei = BigInt(priceWeiStr);
    } catch {
      continue;
    }
    if (opts.maxPriceWei !== undefined && priceWei > opts.maxPriceWei) {
      continue;
    }
    out.push({
      entityKey: entity.key,
      ruleTag,
      confidence,
      priceWei,
      seller: seller as Hex,
    });
  }

  // Sort by confidence desc — highest-quality rules surface first.
  out.sort((a, b) => b.confidence - a.confidence);
  return out;
}

// ---------------------------------------------------------------------------
// 2. Buy + decrypt — buyer-side end-to-end
// ---------------------------------------------------------------------------

/**
 * Send GLM to the SynapticMarket contract for `listingKey`, then poll Arkiv
 * for the grant entity that carries the decryption key.
 *
 * Times out at 60 seconds if the seller's relayer never answers — typically
 * means the seller is offline.
 */
export async function buyAndDecrypt(opts: {
  listingKey: Hex;
  buyerWalletClient: WalletArkivClient;
  marketContract: Hex;
  /** Optional override of poll deadline. Default 60s. */
  timeoutMs?: number;
}): Promise<{ plaintext: string; grantTxHash: string }> {
  const publicClient = getPublicClient();
  const buyer = opts.buyerWalletClient.account?.address;
  if (!buyer) {
    throw new Error(
      "buyAndDecrypt: buyerWalletClient has no account; pass a wallet client with a configured account.",
    );
  }

  // 1. Fetch the listing to learn the price and grab the ciphertext.
  const listing = await publicClient.getEntity(opts.listingKey);

  // Validate entityType BEFORE reading anything else off the entity. Without
  // this check, an attacker can pass any Arkiv entity key — say, an entity
  // whose attributes happen to carry a `priceWei` string — and the buyer
  // will send GLM into the SynapticMarket contract for an entity that has
  // nothing to do with the market. The contract has no way to know the
  // listing key is bogus; it just routes msg.value to whoever registered
  // that bytes32. (See security audit, decrypt-grant.ts §2.)
  const entityTypeAttr = listing.attributes.find(
    (a) => a.key === "entityType",
  )?.value;
  if (entityTypeAttr !== ENTITY_TYPE.LISTING) {
    throw new Error(
      "buyAndDecrypt: entity is not a Synaptic Market listing " +
        `(entityKey=${opts.listingKey}, entityType=${String(entityTypeAttr)})`,
    );
  }

  const priceWeiStr = stringAttr(listing.attributes, "priceWei");
  if (priceWeiStr === undefined) {
    throw new Error(
      `buyAndDecrypt: listing ${opts.listingKey} has no priceWei attribute`,
    );
  }
  const priceWei = BigInt(priceWeiStr);
  const ciphertext = listing.payload;
  if (!ciphertext) {
    throw new Error(
      `buyAndDecrypt: listing ${opts.listingKey} has no payload (was it queried without withPayload?)`,
    );
  }

  // 2. Send the buy() transaction. We encode calldata ourselves rather than
  //    using writeContract() so this works with the WalletArkivClient's
  //    sendTransaction surface (the SDK doesn't expose viem's contract actions).
  const callData = encodeFunctionData({
    abi: SYNAPTIC_MARKET_ABI,
    functionName: "buy",
    args: [opts.listingKey],
  });

  const buyTxHash = await opts.buyerWalletClient.sendTransaction({
    // viem requires the chain + account on the call when not bound at client
    // construction; ours are bound, so just pass to/data/value.
    to: opts.marketContract,
    data: callData,
    value: priceWei,
  } as Parameters<WalletArkivClient["sendTransaction"]>[0]);

  // Wait for inclusion so the seller's grant-watcher actually sees the event.
  await opts.buyerWalletClient.waitForTransactionReceipt({ hash: buyTxHash });

  // 3. Poll Arkiv for the grant entity the seller writes in response.
  //    Filter by listingKey + buyer to disambiguate concurrent buys.
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  const pollIntervalMs = 2_000;

  let grantPayload: Uint8Array | undefined;
  let grantTxHashFromEntity: string | undefined;

  while (Date.now() < deadline) {
    // Grants are written by the seller's session key, not the buyer's — must
    // be a cross-creator read. Attribute filter (listingKey + buyer) narrows
    // it back to grants that actually concern this buyer.
    const result = await cortexQuery({ createdBy: null })
      .where(eq("entityType", ENTITY_TYPE.GRANT))
      .where(eq("listingKey", opts.listingKey.toLowerCase()))
      .where(eq("buyer", buyer.toLowerCase()))
      .withPayload(true)
      .withAttributes(true)
      .withMetadata(true)
      .limit(1)
      .fetch();

    const grant = result.entities[0];
    if (grant && grant.payload) {
      grantPayload = grant.payload;
      grantTxHashFromEntity = stringAttr(grant.attributes, "buyTxHash");
      break;
    }

    await Bun.sleep(pollIntervalMs);
  }

  if (!grantPayload) {
    throw new Error(
      `buyAndDecrypt: timed out after ${timeoutMs}ms waiting for grant entity ` +
        `(listing ${opts.listingKey}, buyer ${buyer}). ` +
        `Seller's relayer may be offline.`,
    );
  }

  // 4. Import the raw key and decrypt the listing's ciphertext.
  if (grantPayload.length !== 32) {
    throw new Error(
      `buyAndDecrypt: grant payload is ${grantPayload.length} bytes; expected 32`,
    );
  }
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(grantPayload),
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const plaintextBytes = await openPayload(cryptoKey, ciphertext);
  const plaintext = new TextDecoder().decode(plaintextBytes);

  return {
    plaintext,
    grantTxHash: grantTxHashFromEntity ?? buyTxHash,
  };
}

// ---------------------------------------------------------------------------
// 3. Grant watcher — seller-side daemon
// ---------------------------------------------------------------------------

export interface GrantWatcherHandle {
  /** Stop the watcher and unsubscribe from contract events. */
  stop: () => void;
}

/**
 * Long-lived watcher: listens for `Grant` events on the SynapticMarket contract
 * and writes a corresponding grant entity to Arkiv for each. The grant entity
 * carries the listing's decryption key as its payload and is tagged with the
 * buyer's address so the buyer can find it via attribute query.
 *
 * Restart-safety: when `db` + `userKey` are provided, the watcher hydrates
 * `listingKeyToDecryptionKey` from the SQLite `listing_keys` table on
 * construction. Each row's sealed key is unsealed with the user-derived wrap
 * key (from `lib/crypto.ts derivePayloadKey`) and merged into the map. If
 * those args aren't provided the watcher still works, but listings written
 * before the last restart are unfulfillable.
 */
export async function startGrantWatcher(opts: {
  marketContract: Hex;
  listingKeyToDecryptionKey: Map<Hex, Uint8Array>;
  /** Optional polling interval override. Default 2s. */
  pollingIntervalMs?: number;
  /** Optional verbose logging hook. */
  onLog?: (msg: string) => void;
  /**
   * SQLite mirror handle. When provided alongside `userKey`, the watcher
   * loads every persisted listing key on boot via `loadAllListingKeys` and
   * unseals each into the in-memory keyMap.
   */
  db?: Database;
  /**
   * User-derived wrap key (`derivePayloadKey(userSignatureHex)`). Required
   * when `db` is provided — otherwise we can't unseal the persisted rows.
   * Throwing here is intentional: silent skip would hide the bug where the
   * wallet sig is missing, and buyers would silently never get fulfilled.
   */
  userKey?: CryptoKey;
}): Promise<GrantWatcherHandle> {
  const publicClient = getPublicClient();
  const log = opts.onLog ?? (() => {});
  let stopped = false;

  // Restart-safe hydration: pull every persisted listing key out of the
  // SQLite mirror and merge into the in-memory map. Without this, buyers who
  // paid before the last restart will time out waiting for grants.
  if (opts.db !== undefined) {
    if (!opts.userKey) {
      throw new Error(
        "startGrantWatcher: userKey is required when db is provided. " +
          "Derive it from the wallet signature first (see lib/crypto.ts " +
          "derivePayloadKey). Without it we can't unseal persisted " +
          "listing keys and restart-safety is broken.",
      );
    }
    const rows = loadAllListingKeys(opts.db);
    for (const row of rows) {
      try {
        // sealPayload writes [nonce || ct+tag]; reassemble before unsealing.
        const reassembled = new Uint8Array(row.nonce.length + row.sealed.length);
        reassembled.set(row.nonce, 0);
        reassembled.set(row.sealed, row.nonce.length);
        const plain = await openPayload(opts.userKey, reassembled);
        opts.listingKeyToDecryptionKey.set(row.entityKey, plain);
      } catch (err) {
        log(
          `[grant-watcher] failed to unseal listing key for ${row.entityKey}: ` +
            `${(err as Error).message}`,
        );
      }
    }
    log(`[grant-watcher] hydrated ${rows.length} listing keys from mirror`);
  } else if (opts.userKey !== undefined) {
    throw new Error(
      "startGrantWatcher: userKey provided without db. Pass both or neither.",
    );
  }

  const unsubscribe = publicClient.watchEvent({
    address: opts.marketContract,
    events: GRANT_EVENTS_ABI,
    pollingInterval: opts.pollingIntervalMs ?? 2_000,
    onLogs: (logs) => {
      if (stopped) return;
      for (const rawLog of logs as Log[]) {
        handleGrantLog(rawLog, opts.listingKeyToDecryptionKey, log).catch(
          (err) => {
            console.error("[grant-watcher] failed to fulfill grant:", err);
          },
        );
      }
    },
    onError: (err) => {
      console.error("[grant-watcher] watcher error:", err);
    },
  });

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      log("[grant-watcher] stopped");
    },
  };
}

async function handleGrantLog(
  rawLog: Log,
  keyMap: Map<Hex, Uint8Array>,
  log: (msg: string) => void,
): Promise<void> {
  let decoded:
    | { args: { listingKey: Hex; buyer: Address; paidPrice: bigint; timestamp: bigint } }
    | undefined;
  try {
    const res = decodeEventLog({
      abi: SYNAPTIC_MARKET_ABI,
      data: rawLog.data,
      topics: rawLog.topics,
      eventName: "Grant",
    });
    decoded = res as typeof decoded;
  } catch (err) {
    log(`[grant-watcher] could not decode log: ${(err as Error).message}`);
    return;
  }
  if (!decoded) return;

  const { listingKey, buyer, paidPrice } = decoded.args;
  const decryptionKey = keyMap.get(listingKey);
  if (!decryptionKey) {
    log(
      `[grant-watcher] ignoring grant for unknown listing ${listingKey} ` +
        `(buyer ${buyer}); relayer may have restarted`,
    );
    return;
  }

  // Write the grant entity. payload = raw 32-byte key. Attributes carry the
  // join keys (listingKey + buyer) so the buyer can find this entity.
  const sellerAddr = getSessionKeyAddress();
  const { entityKey, txHash } = await singleCreate({
    payload: decryptionKey,
    contentType: "application/octet-stream",
    attributes: [
      { key: "entityType", value: ENTITY_TYPE.GRANT },
      { key: "listingKey", value: listingKey.toLowerCase() },
      { key: "buyer", value: buyer.toLowerCase() },
      { key: "seller", value: sellerAddr.toLowerCase() },
      { key: "paidPriceWei", value: paidPrice.toString() },
      { key: "buyTxHash", value: rawLog.transactionHash ?? "0x" },
      { key: "grantedAt", value: Date.now() },
    ],
    // Grants are short-lived — the buyer reads them once and is done.
    expiresInSeconds: 24 * 60 * 60,
  });

  log(
    `[grant-watcher] fulfilled grant: listing=${listingKey} buyer=${buyer} ` +
      `entity=${entityKey} tx=${txHash}`,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stringAttr(
  attrs: readonly { key: string; value: string | number }[],
  key: string,
): string | undefined {
  const a = attrs.find((x) => x.key === key);
  if (!a) return undefined;
  return typeof a.value === "string" ? a.value : String(a.value);
}

function numberAttr(
  attrs: readonly { key: string; value: string | number }[],
  key: string,
): number | undefined {
  const a = attrs.find((x) => x.key === key);
  if (!a) return undefined;
  return typeof a.value === "number" ? a.value : Number(a.value);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return buf;
}
