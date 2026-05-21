/**
 * Cortex — Synaptic Market: listing publisher.
 *
 * What this does:
 *   1. Generates a fresh AES-256-GCM key for this listing only (NOT the user's
 *      wallet-derived key). Each listing gets its own key so we can release one
 *      to a buyer without leaking the seller's other memories.
 *   2. Seals the distilled rule text with that key (via lib/crypto.ts).
 *   3. Writes an Arkiv entity with the ciphertext as payload and PUBLIC tags
 *      describing the rule (ruleTag, confidence, priceWei, sellerAddr).
 *   4. Returns the per-listing key to the caller — the seller's relayer holds
 *      it in memory and releases it via a grant entity when a Grant event fires.
 *
 * The trick the Synaptic Market exploits: Arkiv is a queryable public DB.
 * Other agents can discover listings via attribute queries WITHOUT decrypting
 * anything. Decryption only happens after on-chain payment (see decrypt-grant.ts).
 *
 * The decryption key is intentionally NOT derived from the seller's primary
 * wallet. That key (from lib/crypto.ts derivePayloadKey) is the seller's
 * private memory key; using it for listings would let buyers decrypt the
 * seller's entire memory.
 */

import type { Hex } from "@arkiv-network/sdk";
import type { Attribute } from "@arkiv-network/sdk/types";
import type { Database } from "bun:sqlite";
import { sealPayload } from "../lib/crypto";
import { singleCreate } from "../lib/batch-writer";
import { getSessionKeyAddress } from "../lib/arkiv-client";
import { saveListingKey } from "../mirror/db";
import { ENTITY_TYPE } from "../constants";

/** Lifespan of a market listing. Rules go stale; 30 days is the demo default. */
const LISTING_LIFESPAN_SECONDS = 30 * 24 * 60 * 60;

export interface PublishListingResult {
  entityKey: Hex;
  txHash: string;
  priceWei: bigint;
  /** 32-byte AES-256-GCM key. The seller's relayer holds this until a Grant event. */
  decryptionKey: Uint8Array;
}

/**
 * Publish a distilled rule to the Synaptic Market.
 *   - Encrypts ruleText with a fresh per-listing AES-256-GCM key
 *   - Writes an Arkiv entity:
 *       entityType=LISTING, ruleTag=<topic>, priceWei=<as string>, confidence=<0-100>
 *       payload = sealed ciphertext
 *       expiresIn = 30 days (rules go stale)
 *   - Returns the decryption key (caller stores it in the daemon's grant table)
 */
export async function publishListing(opts: {
  ruleText: string;
  ruleTag: string;
  confidence: number;
  priceWei: bigint;
  /**
   * User-derived wrap key, from `derivePayloadKey(userSignatureHex)` in
   * `lib/crypto.ts`. We seal the fresh per-listing AES key under this and
   * persist it via `saveListingKey` so the grant-watcher can rehydrate
   * after a restart. If omitted, persistence is skipped — and the caller
   * is responsible for accepting that "process restart = unfulfillable".
   * For the demo runner this is always provided.
   */
  userKey?: CryptoKey;
  /**
   * SQLite mirror handle. Required when `userKey` is provided — we persist
   * the sealed listing key to the `listing_keys` table so the relayer can
   * survive a restart.
   */
  db?: Database;
}): Promise<PublishListingResult> {
  if (!opts.ruleText) {
    throw new Error("publishListing: ruleText must be non-empty");
  }
  if (!opts.ruleTag) {
    throw new Error("publishListing: ruleTag must be non-empty");
  }
  if (!Number.isFinite(opts.confidence) || opts.confidence < 0 || opts.confidence > 100) {
    throw new Error(
      `publishListing: confidence must be 0-100, got ${opts.confidence}`,
    );
  }
  if (opts.priceWei < 0n) {
    throw new Error("publishListing: priceWei must be non-negative");
  }

  // 1. Mint a fresh per-listing key. Per-listing isolation is load-bearing —
  //    see file header.
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(rawKey),
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  // 2. Seal the rule text. The sealed payload layout (nonce || ct+tag) matches
  //    lib/crypto.ts openPayload exactly.
  const plaintext = new TextEncoder().encode(opts.ruleText);
  const sealed = await sealPayload(cryptoKey, plaintext);

  // 3. Build the public attribute set. priceWei is stringified — Arkiv
  //    attributes are string|number and bigint won't survive serialization.
  //    Confidence is numeric so orderBy can range over it.
  const sellerAddr = getSessionKeyAddress();
  const attributes: Attribute[] = [
    { key: "entityType", value: ENTITY_TYPE.LISTING },
    { key: "ruleTag", value: opts.ruleTag },
    { key: "confidence", value: opts.confidence },
    { key: "priceWei", value: opts.priceWei.toString() },
    { key: "seller", value: sellerAddr.toLowerCase() },
    { key: "publishedAt", value: Date.now() },
  ];

  // 4. Write to Arkiv. PROJECT_ATTRIBUTE is stamped by batch-writer.
  const { entityKey, txHash } = await singleCreate({
    payload: sealed,
    contentType: "application/octet-stream",
    attributes,
    expiresInSeconds: LISTING_LIFESPAN_SECONDS,
  });

  // 5. Persist the per-listing key so the grant-watcher survives a restart.
  //    We seal the raw 32-byte AES key under the user-derived wrap key (from
  //    derivePayloadKey) and store the sealed bundle in the SQLite mirror.
  //    Without this step, a process restart leaves already-paid buyers
  //    without fulfilment (they sent GLM and never get the decryption key).
  if (opts.userKey !== undefined) {
    if (!opts.db) {
      throw new Error(
        "publishListing: db is required when userKey is provided " +
          "(we need to persist the sealed listing key for restart-safety)",
      );
    }
    const sealedKey = await sealPayload(opts.userKey, rawKey);
    // sealPayload returns [nonce(12) || ct+tag]. Split for the schema's
    // separate `nonce` + `decryption_key_sealed` columns.
    const nonce = sealedKey.slice(0, 12);
    const ct = sealedKey.slice(12);
    saveListingKey(opts.db, entityKey, ct, nonce);
  } else if (opts.db) {
    throw new Error(
      "publishListing: userKey must be provided to persist the listing key. " +
        "Derive it from the wallet signature first (see lib/crypto.ts " +
        "derivePayloadKey). Without persistence, process restart leaves " +
        "already-paid buyers unfulfillable.",
    );
  }

  return {
    entityKey,
    txHash,
    priceWei: opts.priceWei,
    decryptionKey: rawKey,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return buf;
}
