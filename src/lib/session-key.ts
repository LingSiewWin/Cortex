/**
 * Cortex — session-key lifecycle helpers.
 *
 * Implements the §2.2 + §2.1 stack from docs/ERC.md:
 *   - Generate an ephemeral session-key EOA (the `$creator` for every Arkiv write)
 *   - Build a SessionAuthorization typed struct bounding what the relayer may do
 *   - Verify the user's signature with ERC-1271 + ERC-6492 transparency
 *
 * Why `verifyTypedData` from viem (and not raw `ecrecover`):
 *   - EOA path: same result as ecrecover.
 *   - ERC-1271 path: when `publicClient` is provided, viem calls
 *     `isValidSignature(hash, sig)` against the smart contract, so Safe /
 *     Coinbase Smart Wallet users round-trip.
 *   - ERC-6492 path: viem detects the magic suffix and validates counterfactual
 *     (not-yet-deployed) wallets via `eth_call` with the factory bytecode prefix.
 *
 * The utility `verifyTypedData` (from `viem`) is EOA-only — sufficient for the
 * relayer-funded session-key case during tests. For a real smart-wallet user
 * sign-in, pass a `publicClient` so viem can route to the 1271/6492 path.
 */

import { generatePrivateKey, privateKeyToAccount } from "@arkiv-network/sdk/accounts";
import type { PrivateKeyAccount } from "viem/accounts";
import { hashTypedData, verifyTypedData, type Hex, type PublicClient } from "viem";
import { SESSION } from "../constants";
import {
  getSessionAuthorizationTypedData,
  getSessionAuthorizationV2TypedData,
  type SessionAuthorization,
  type SessionAuthorizationV2,
} from "./eip712";

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/** Result of generating a fresh session-key EOA. */
export interface GeneratedSessionKey {
  account: PrivateKeyAccount;
  privateKey: Hex;
}

/**
 * Generate a fresh session-key EOA. The relayer should:
 *   1. Persist `privateKey` only in memory (or an encrypted store) for the
 *      session's lifetime.
 *   2. Discard it as soon as `validBefore` elapses.
 *
 * Per docs/ERC.md §6.1, the session-key relayer is a trusted intermediary in
 * v1; the persistence policy here is what bounds that trust in practice.
 */
export function generateSessionKeyAccount(): GeneratedSessionKey {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  return { account, privateKey };
}

// ---------------------------------------------------------------------------
// Authorization builder
// ---------------------------------------------------------------------------

/** Parameters required to construct a SessionAuthorization. */
export interface BuildSessionAuthorizationInput {
  /** The user's primary EOA (will become `$owner` post-promotion). */
  user: Hex;
  /** The session-key EOA address from `generateSessionKeyAccount`. */
  sessionKey: Hex;
  /**
   * Duration the authorization is valid for, in seconds. Defaults to
   * `SESSION.defaultValidDurationSeconds` (4 hours).
   */
  durationSeconds?: number;
  /** Hard cap on writes. Defaults to `SESSION.defaultMaxWrites` (1000). */
  maxWrites?: bigint;
  /**
   * The Arkiv subtree the session is scoped to. Typically a hash of
   * `keccak256(user || projectId)` — Cortex computes this upstream when
   * deriving per-user namespaces.
   */
  entityNamespace: Hex;
  /**
   * Override the "now" used for `validAfter`. Mainly for deterministic tests.
   * Defaults to `Date.now() / 1000`.
   */
  nowSeconds?: number;
  /**
   * Override the nonce. Mainly for deterministic tests. Defaults to a fresh
   * cryptographically random 32 bytes.
   */
  nonce?: Hex;
  /**
   * Scope tag. Defaults to `SCOPE_ARKIV_WRITE` (the standard write capability
   * per docs/ERC.md §2.1). Kept as an explicit field so callers can opt into
   * future scopes (e.g. `arkiv.read`), but the verifier rejects anything
   * other than `SCOPE_ARKIV_WRITE` unless `allowedScopes` is passed.
   */
  scope?: Hex;
}

/**
 * keccak256("arkiv.write") — the standard write capability tag.
 * Pre-computed so we don't pull in `keccak256` for every build call.
 *
 * Derivation (verified via viem.keccak256(toBytes("arkiv.write"))):
 *   keccak256("arkiv.write") = 0x40f832b3fbcb51c9516e3df56c20fa46af331380021ff94f331f3bbf4d42cdec
 *
 * The test `default scope is keccak256('arkiv.write')` re-derives this on
 * every CI run, so drift is caught the moment the constant gets edited.
 */
export const SCOPE_ARKIV_WRITE: Hex =
  "0x40f832b3fbcb51c9516e3df56c20fa46af331380021ff94f331f3bbf4d42cdec";

/**
 * Build a SessionAuthorization struct with sensible defaults. Doesn't sign —
 * pass the result to `account.signTypedData(getSessionAuthorizationTypedData(...))`.
 */
export function buildSessionAuthorization(
  input: BuildSessionAuthorizationInput,
): SessionAuthorization {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const duration = input.durationSeconds ?? SESSION.defaultValidDurationSeconds;
  const maxWrites = input.maxWrites ?? BigInt(SESSION.defaultMaxWrites);
  const nonce = input.nonce ?? randomBytes32();
  const scope = input.scope ?? SCOPE_ARKIV_WRITE;

  return {
    user: input.user,
    sessionKey: input.sessionKey,
    scope,
    entityNamespace: input.entityNamespace,
    maxWrites,
    validAfter: BigInt(now),
    validBefore: BigInt(now + duration),
    nonce,
  };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Verify a SessionAuthorization signature. Two modes:
 *
 *   - Without `publicClient`: EOA-only verification (uses viem's offline
 *     utility — sufficient for testing and EOA-signer flows).
 *   - With `publicClient`: routes through viem's chain-aware verifier, which
 *     transparently handles ERC-1271 (deployed smart-contract wallets) and
 *     ERC-6492 (counterfactual / not-yet-deployed wallets).
 *
 * The expected signer is `authorization.user` — the wallet that authorized
 * the session. The session key itself never signs the authorization.
 */
export async function verifySessionAuthorization(
  authorization: SessionAuthorization,
  signatureHex: Hex,
  options?: { publicClient?: PublicClient; allowedScopes?: Hex[] },
): Promise<boolean> {
  // Scope tag enforcement — by default only `SCOPE_ARKIV_WRITE` is accepted.
  // Callers that need a different scope must pass `allowedScopes` explicitly
  // so the relayer surface stays narrow. The SDK helper defaults the scope to
  // `SCOPE_ARKIV_WRITE`, but this check is the load-bearing gate.
  const allowed = options?.allowedScopes ?? [SCOPE_ARKIV_WRITE];
  if (!allowed.includes(authorization.scope)) {
    return false;
  }
  const typedData = getSessionAuthorizationTypedData(authorization);
  if (options?.publicClient) {
    // Chain-aware path — hash the typed data, then ask viem's `verifyHash` to
    // route through EOA / ERC-1271 / ERC-6492 transparently. We use verifyHash
    // (not verifyTypedData) because (a) it's the only path that handles 6492
    // counterfactual wallets, and (b) it sidesteps the strict TypedData generic
    // inference that doesn't accept Cortex's narrow message type as-is.
    const digest = hashTypedData({
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
    });
    return options.publicClient.verifyHash({
      address: authorization.user,
      hash: digest,
      signature: signatureHex,
    });
  }
  // EOA-only path — fine for tests and EOA users.
  return verifyTypedData({
    address: authorization.user,
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message,
    signature: signatureHex,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fresh 32 random bytes, hex-encoded. */
function randomBytes32(): Hex {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  let out = "0x";
  for (const b of buf) {
    out += b.toString(16).padStart(2, "0");
  }
  return out as Hex;
}

// ---------------------------------------------------------------------------
// V2 — Agent Allowance builder + verifier
// ---------------------------------------------------------------------------

/** Parameters for a V2 SessionAuthorization (Agent Allowance). */
export interface BuildSessionAuthorizationV2Input {
  /** Master EOA — signs the authorization, becomes Arkiv `$owner`. */
  user: Hex;
  /** The session-key EOA from `generateSessionKeyAccount`. */
  sessionKey: Hex;
  /** Arkiv subtree this allowance is scoped to. */
  entityNamespace: Hex;
  /** Cumulative GLM ceiling in wei. */
  maxGasWei: bigint;
  /** Dashboard alerts when remaining ≤ threshold. */
  refillThresholdWei: bigint;
  /** Master's projected daily burn (display-only). */
  estimatedDailyCostWei: bigint;
  /** Defaults to `SESSION.defaultValidDurationSeconds` (4h). */
  durationSeconds?: number;
  /** Defaults to `SESSION.defaultMaxWrites` (1000). */
  maxWrites?: bigint;
  /** Override "now" for deterministic tests. */
  nowSeconds?: number;
  /** Override nonce for deterministic tests. */
  nonce?: Hex;
  /** Scope tag. Defaults to `SCOPE_ARKIV_WRITE`. */
  scope?: Hex;
}

/**
 * Build a V2 SessionAuthorization (Agent Allowance) struct. Doesn't sign —
 * hand the result through `getSessionAuthorizationV2TypedData` to a signer.
 *
 * Bigint discipline: every wei field is a bigint here and over the wire is
 * a decimal string. EIP-712 `uint256` converts natively.
 */
export function buildSessionAuthorizationV2(
  input: BuildSessionAuthorizationV2Input,
): SessionAuthorizationV2 {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const duration = input.durationSeconds ?? SESSION.defaultValidDurationSeconds;
  const maxWrites = input.maxWrites ?? BigInt(SESSION.defaultMaxWrites);
  const nonce = input.nonce ?? randomBytes32();
  const scope = input.scope ?? SCOPE_ARKIV_WRITE;

  return {
    user: input.user,
    sessionKey: input.sessionKey,
    scope,
    entityNamespace: input.entityNamespace,
    maxWrites,
    maxGasWei: input.maxGasWei,
    refillThresholdWei: input.refillThresholdWei,
    estimatedDailyCostWei: input.estimatedDailyCostWei,
    validAfter: BigInt(now),
    validBefore: BigInt(now + duration),
    nonce,
  };
}

/**
 * Verify a V2 SessionAuthorization signature. Same surface as `verifySessionAuthorization`:
 *
 *   - Without `publicClient`: EOA-only (viem's offline `verifyTypedData`).
 *   - With `publicClient`: chain-aware, routes through ERC-1271 / ERC-6492.
 *
 * The default allowedScopes list contains only `SCOPE_ARKIV_WRITE`.
 */
export async function verifySessionAuthorizationV2(
  authorization: SessionAuthorizationV2,
  signatureHex: Hex,
  options?: { publicClient?: PublicClient; allowedScopes?: Hex[] },
): Promise<boolean> {
  const allowed = options?.allowedScopes ?? [SCOPE_ARKIV_WRITE];
  if (!allowed.includes(authorization.scope)) {
    return false;
  }
  const typedData = getSessionAuthorizationV2TypedData(authorization);
  try {
    if (options?.publicClient) {
      const digest = hashTypedData({
        domain: typedData.domain,
        types: typedData.types,
        primaryType: typedData.primaryType,
        message: typedData.message,
      });
      return await options.publicClient.verifyHash({
        address: authorization.user,
        hash: digest,
        signature: signatureHex,
      });
    }
    return await verifyTypedData({
      address: authorization.user,
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
      signature: signatureHex,
    });
  } catch {
    // viem throws on malformed signatures (bad yParity, wrong length, etc.).
    // For the relayer's purposes "malformed" is just a failed verification —
    // return false so callers can branch on a bool instead of catching.
    return false;
  }
}
