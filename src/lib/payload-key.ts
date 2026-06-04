/**
 * Cortex — wallet-derived payload-key provider (the sovereignty keystone).
 *
 * Memories are encrypted client-side before they hit Arkiv. The AES-256-GCM key
 * is derived deterministically from the user's primary wallet (see
 * `src/lib/crypto.ts`): the wallet signs a fixed domain-separated message, and
 * that signature HKDF-expands into the key. Same wallet → same key → a fresh
 * machine with only the wallet can re-sync ciphertext from the public Arkiv RPC
 * and decrypt it. No key escrow, no operator dependency.
 *
 * Key material is resolved once and memoized. Two sources, in priority order:
 *   1. `CORTEX_USER_SIGNATURE` — the 65-byte EIP-191 signature itself. This is
 *      the ONLY secret a fresh machine needs (the "Proof of Sovereignty" path):
 *      no private key ever touches this process.
 *   2. `CORTEX_USER_PRIVATE_KEY` — dev convenience: sign the derivation message
 *      in-process. Should be the user's PRIMARY EOA key. Never sent anywhere.
 *
 * If neither is present, the key is `null`: sealed memories cannot be opened, so
 * recall skips them (a miss, not a crash) — that is exactly the negative control
 * that proves the wallet is load-bearing.
 */

import type { Hex } from "@arkiv-network/sdk";
import { privateKeyToAccount } from "@arkiv-network/sdk/accounts";
import { derivePayloadKey, keyDerivationMessage } from "./crypto.ts";
import { resolveCredentials } from "./credentials.ts";

// `undefined` = not yet resolved; `null` = resolved, no wallet material.
let _cached: CryptoKey | null | undefined;

async function resolveSignature(): Promise<Hex | null> {
  const creds = resolveCredentials();

  // Precedence preserved: env signature > env private-key (sign in-process) > config signature.
  // 1. Explicit signature from env — the fresh-machine "Proof of Sovereignty" path.
  if (creds.source.signature === "env") return creds.userSignature as Hex;

  // 2. Dev convenience: sign the derivation message with the primary private key.
  if (creds.userPrivateKey) {
    const account = privateKeyToAccount(creds.userPrivateKey as Hex);
    const message = keyDerivationMessage(account.address);
    return (await account.signMessage({ message })) as Hex;
  }

  // 3. Signature `cortex auth` captured into ~/.cortex/config.json.
  if (creds.source.signature === "config") return creds.userSignature as Hex;

  return null;
}

/**
 * Memoized wallet-derived AES key, or `null` when no wallet material is present.
 * Callers that read memories should skip sealed entities when this is null.
 *
 * The dashboard's owner-identity singleton wins when populated (set by
 * /api/auth/adopt when the browser connects). Legacy env / config fallbacks
 * stay intact for headless and plugin scenarios. Lazy import avoids a
 * circular dep at module-load time (owner-identity imports from crypto.ts).
 */
export async function getPayloadKey(): Promise<CryptoKey | null> {
  const { getEffective } = await import("../agent/owner-identity");
  const singletonKey = (await getEffective()).payloadKey;
  if (singletonKey) return singletonKey;

  if (_cached !== undefined) return _cached;
  const sig = await resolveSignature();
  _cached = sig ? await derivePayloadKey(sig) : null;
  return _cached;
}

/** Like `getPayloadKey` but throws — used by the write path, which cannot seal without a key. */
export async function requirePayloadKey(): Promise<CryptoKey> {
  const key = await getPayloadKey();
  if (!key) {
    throw new Error(
      "Cortex payload key unavailable: set CORTEX_USER_SIGNATURE (preferred) or " +
        "CORTEX_USER_PRIVATE_KEY (dev) so memories can be sealed/opened. " +
        "See scripts/derive-user-signature.ts to generate a signature.",
    );
  }
  return key;
}

/** True when wallet key material is available (without forcing derivation to throw). */
export async function hasPayloadKey(): Promise<boolean> {
  return (await getPayloadKey()) !== null;
}

/** Test seam: force a specific key (or `null`) and bypass env resolution. */
export function _setPayloadKeyForTest(key: CryptoKey | null): void {
  _cached = key;
}

/** Test seam: clear the memoized key so the next call re-resolves from env. */
export function _resetPayloadKey(): void {
  _cached = undefined;
}
