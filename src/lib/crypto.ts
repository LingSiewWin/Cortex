/**
 * Cortex — deterministic key derivation.
 *
 * Solves Flaw F from docs/discussion2 ("encrypted payload can't be self-decrypted"):
 *
 *   1. The user signs a fixed domain-separated message with their primary wallet
 *      (the same wallet that owns Cortex entities post-promotion).
 *   2. We HKDF-expand the signature into per-purpose 32-byte keys.
 *   3. The same wallet always produces the same signature → same keys → the
 *      SQLite mirror replay daemon can decrypt offline with just the user's
 *      wallet, no central key escrow.
 *
 * Domain string is pinned in src/constants.ts. Changing it invalidates all prior
 * derived keys — treat as a hard versioning boundary.
 *
 * SECURITY NOTE for the README's Trust Assumptions: this trades perfect-forward-
 * secrecy for portability. If the user's primary EOA private key leaks, all
 * historically-encrypted payloads are decryptable by the attacker. That's the
 * right tradeoff for an "agents whose memory you actually own" pitch — the
 * memory is bound to the wallet by design.
 */

import { SESSION } from "../constants";

// The canonical message lives in its own dependency-free module so the browser
// connect app can import it without pulling in constants.ts (process.env). Both
// sides MUST use the same builder or the derived key silently mismatches.
export { keyDerivationMessage } from "./derivation-message";

const DERIVATION_INFO_PAYLOAD = "cortex.payload.aes256gcm";
const DERIVATION_INFO_INDEX = "cortex.index.kdf";

/**
 * Derive a 32-byte AES-256-GCM key from the user's signature.
 *
 * @param signatureHex 65-byte EIP-191 signature, hex-encoded (0x-prefixed)
 * @returns 32-byte CryptoKey ready for AES-GCM encrypt/decrypt
 */
export async function derivePayloadKey(signatureHex: string): Promise<CryptoKey> {
  const seed = toArrayBuffer(hexToBytes(signatureHex));
  const ikm = await crypto.subtle.importKey("raw", seed, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      // RFC 5869 §3.1: a non-empty, non-secret salt provides cross-protocol
      // domain separation. Reusing the SIWE/key-derivation domain string here
      // means a signature obtained via a future protocol that happens to use
      // the same root sig can't be passed through the same HKDF to recover
      // the AES key. The string is not secret; it's just a labeled separator.
      salt: new TextEncoder().encode(SESSION.keyDerivationDomain),
      info: new TextEncoder().encode(DERIVATION_INFO_PAYLOAD),
    },
    ikm,
    256, // bits
  );
  return crypto.subtle.importKey("raw", bits, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Derive a 32-byte index-key (used for searchable-encryption / blind tagging in v2).
 * Currently unused — exported so the derivation domain stays stable as we add
 * features that need additional purpose-keyed material from the same root sig.
 */
export async function deriveIndexKey(signatureHex: string): Promise<Uint8Array> {
  const seed = toArrayBuffer(hexToBytes(signatureHex));
  const ikm = await crypto.subtle.importKey("raw", seed, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      // RFC 5869 §3.1: a non-empty, non-secret salt provides cross-protocol
      // domain separation. Reusing the SIWE/key-derivation domain string here
      // means a signature obtained via a future protocol that happens to use
      // the same root sig can't be passed through the same HKDF to recover
      // the AES key. The string is not secret; it's just a labeled separator.
      salt: new TextEncoder().encode(SESSION.keyDerivationDomain),
      info: new TextEncoder().encode(DERIVATION_INFO_INDEX),
    },
    ikm,
    256,
  );
  return new Uint8Array(bits);
}

// ---------------------------------------------------------------------------
// AES-GCM seal / open
// ---------------------------------------------------------------------------

const NONCE_BYTES = 12;

/**
 * Encrypt a payload with the derived AES-256-GCM key. Output layout:
 *   [nonce (12 bytes) || ciphertext+tag]
 * The nonce is random per-message. Length-preserving up to GCM overhead (16 bytes).
 */
export async function sealPayload(key: CryptoKey, plaintext: Uint8Array): Promise<Uint8Array> {
  const nonceBytes = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const nonce = toArrayBuffer(nonceBytes);
  const pt = toArrayBuffer(plaintext);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, pt);
  const out = new Uint8Array(NONCE_BYTES + ct.byteLength);
  out.set(nonceBytes, 0);
  out.set(new Uint8Array(ct), NONCE_BYTES);
  return out;
}

/**
 * Decrypt a payload sealed by `sealPayload`. Throws if the tag fails verification.
 */
export async function openPayload(key: CryptoKey, sealed: Uint8Array): Promise<Uint8Array> {
  if (sealed.length <= NONCE_BYTES) {
    throw new Error("Sealed payload too short to contain a nonce");
  }
  const nonce = toArrayBuffer(sealed.slice(0, NONCE_BYTES));
  const ct = toArrayBuffer(sealed.slice(NONCE_BYTES));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ct);
  return new Uint8Array(pt);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error("hex string has odd length");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Coerce a Uint8Array of any underlying buffer type into a fresh ArrayBuffer.
 * Needed because crypto.subtle requires `Uint8Array<ArrayBuffer>` (not the
 * `ArrayBufferLike` that crypto.getRandomValues / Buffer return).
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return buf;
}
