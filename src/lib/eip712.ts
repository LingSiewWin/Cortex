/**
 * Cortex — EIP-712 typed-data primitives for session authorizations.
 *
 * Implements the §2.1 stack from docs/ERC.md:
 *   - EIP-712 typed signature for `SessionAuthorization`
 *   - ERC-5267 `eip712Domain()` mirror (so the dashboard can introspect the same
 *     domain the smart wallet / Safe / counterfactual-CSW would see)
 *
 * The verifyingContract is the zero address for v1: Cortex's registry isn't
 * deployed yet (per docs/ERC.md §2.6 — ERC-8004 event-shape mimicry, not a
 * full impl). When/if a registry deploys, swap `VERIFYING_CONTRACT_V1` for its
 * address and bump the version string. Until then, the typed-data digest is
 * still well-defined: the signer commits to a chainId + zero-address domain,
 * which is what the off-chain relayer enforces.
 *
 * Borrowed pattern (validAfter / validBefore / bytes32 nonce) is from ERC-3009,
 * battle-tested in USDC.
 */

import { hashTypedData, keccak256, toBytes, type Hex, type TypedDataDomain } from "viem";
import { BRAGA, PROJECT_ATTRIBUTE } from "../constants";

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

/**
 * v1 verifyingContract — explicitly zero until the registry deploys. The signed
 * digest is still chain-bound via `chainId` and human-bound via the SIWE prompt
 * that pairs with the signature.
 *
 * Because `verifyingContract` is 0x0 across all v1 deployments, two Cortex
 * deployments on the same chain would produce byte-identical EIP-712 digests
 * for the same SessionAuthorization. The audit flagged this as a
 * cross-deployment signature-replay risk. We close the gap by adding a
 * non-zero `salt` derived from `chainId || PROJECT_ATTRIBUTE.value`, which
 * is unique per deployment (e.g. `cortex-ethns-2026`).
 */
export const VERIFYING_CONTRACT_V1: Hex =
  "0x0000000000000000000000000000000000000000";

/**
 * Domain salt — `keccak256(`${chainId}:${PROJECT_ATTRIBUTE.value}`)`.
 * Pre-computed once at module load. Updating either `BRAGA.chainId` or
 * `PROJECT_ATTRIBUTE.value` invalidates every previously-issued
 * SessionAuthorization, which is the desired behavior: a fresh deployment
 * gets a fresh signature surface.
 */
export const CORTEX_DOMAIN_SALT: Hex = keccak256(
  toBytes(`${BRAGA.chainId}:${PROJECT_ATTRIBUTE.value}`),
);

/** Pinned EIP-712 domain. Bump `version` only with explicit user approval. */
export const CORTEX_EIP712_DOMAIN: TypedDataDomain = {
  name: "Cortex",
  version: "1",
  chainId: BRAGA.chainId,
  verifyingContract: VERIFYING_CONTRACT_V1,
  salt: CORTEX_DOMAIN_SALT,
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The typed struct the user signs to authorize the Cortex relayer to act on
 * their behalf. Matches docs/ERC.md §2.1 exactly.
 */
export interface SessionAuthorization {
  /** Signer / Arkiv `$owner`. */
  user: Hex;
  /** Ephemeral EOA the relayer holds. Becomes `$creator` on every Arkiv write. */
  sessionKey: Hex;
  /** Capability tag — `keccak256("arkiv.write")` for the standard write scope. */
  scope: Hex;
  /** Restricts the session to a single Arkiv subtree (e.g. user-derived namespace). */
  entityNamespace: Hex;
  /** Hard cap on Arkiv write count over the session. */
  maxWrites: bigint;
  /** Unix seconds — earliest moment the relayer may submit a write. */
  validAfter: bigint;
  /** Unix seconds — latest moment a write under this auth is accepted. */
  validBefore: bigint;
  /** Random 32-byte nonce. Burning it cancels the session out-of-order. */
  nonce: Hex;
}

/** EIP-712 type definitions — pinned. Renaming a field invalidates every signature. */
export const SESSION_AUTHORIZATION_TYPES = {
  SessionAuthorization: [
    { name: "user", type: "address" },
    { name: "sessionKey", type: "address" },
    { name: "scope", type: "bytes32" },
    { name: "entityNamespace", type: "bytes32" },
    { name: "maxWrites", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/**
 * The exact payload `signTypedData` / `verifyTypedData` / `hashTypedData` expect.
 * Returning this lets a caller hand it straight to any viem signer (account,
 * walletClient, or wagmi mutation) without remembering the wiring.
 */
export interface SessionAuthorizationTypedData {
  domain: TypedDataDomain;
  types: typeof SESSION_AUTHORIZATION_TYPES;
  primaryType: "SessionAuthorization";
  message: SessionAuthorization;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/**
 * Returns the full typed-data payload for a SessionAuthorization. Hand directly
 * to `account.signTypedData(...)`, `walletClient.signTypedData(...)`, or
 * `verifyTypedData({...})`.
 */
export function getSessionAuthorizationTypedData(
  authorization: SessionAuthorization,
): SessionAuthorizationTypedData {
  return {
    domain: CORTEX_EIP712_DOMAIN,
    types: SESSION_AUTHORIZATION_TYPES,
    primaryType: "SessionAuthorization",
    message: authorization,
  };
}

/**
 * Computes the EIP-712 digest the signer commits to. Equivalent to:
 *   keccak256(0x1901 || domainSeparator || hashStruct(message))
 *
 * Useful for off-chain audit, ERC-1271 `isValidSignature(hash, sig)` calls,
 * and the dashboard's "verify this signature for me" client-side check.
 */
export function hashSessionAuthorization(
  authorization: SessionAuthorization,
): Hex {
  return hashTypedData(getSessionAuthorizationTypedData(authorization));
}

// ---------------------------------------------------------------------------
// ERC-5267 mirror
// ---------------------------------------------------------------------------

/**
 * ERC-5267 `eip712Domain()` return-shape, computed client-side so the dashboard
 * can display the same fields a Solidity contract would expose. The `fields`
 * bitmap is 0x0f = 0b01111 → {name, version, chainId, verifyingContract} all
 * present; salt and extensions are empty.
 *
 * Reference: docs/ERC.md §2.1, /docs/ERC/erc-knowledge-base/ercs/erc-5267.md.
 */
export interface Eip712DomainView {
  fields: Hex; // bytes1
  name: string;
  version: string;
  chainId: bigint;
  verifyingContract: Hex;
  salt: Hex; // bytes32
  extensions: bigint[];
}

export function eip712DomainView(): Eip712DomainView {
  // bitmap 0x1f = 0b11111 → {name, version, chainId, verifyingContract, salt}
  // all present. Bit 0x10 = salt; we now ship a deployment-specific salt so
  // the bit is set.
  return {
    fields: "0x1f",
    name: "Cortex",
    version: "1",
    chainId: BigInt(BRAGA.chainId),
    verifyingContract: VERIFYING_CONTRACT_V1,
    salt: CORTEX_DOMAIN_SALT,
    extensions: [],
  };
}

// ---------------------------------------------------------------------------
// SessionAuthorizationV2 — Agent Allowance pattern
// ---------------------------------------------------------------------------

/**
 * V2 is strictly ADDITIVE over V1 (see docs/ERC.md §2.1 + §3.5). Both type
 * names coexist; the primaryType (`SessionAuthorizationV2`) is what makes
 * their EIP-712 typeHashes differ — re-using V1's signature against a V2
 * verifier (or vice versa) is impossible because the typeHash is part of
 * the digest.
 *
 * The three new fields encode the "parent sets a monthly allowance for the
 * AI child" flow:
 *   - maxGasWei: hard ceiling on cumulative GLM the relayer may spend
 *   - refillThresholdWei: dashboard alert level (remaining ≤ threshold)
 *   - estimatedDailyCostWei: master's projection (display-only, not enforced;
 *     the relayer enforces maxGasWei + maxWrites + validBefore as the budget)
 *
 * ERC-7715 (DelegationManager) would let us put this on-chain, but Braga
 * doesn't ship one — so the relayer enforces it off-chain and the master
 * re-signs every refill. The signed authorization is the source of truth.
 */
export interface SessionAuthorizationV2 {
  /** Signer / Arkiv `$owner`. The master EOA. */
  user: Hex;
  /** Ephemeral EOA the relayer holds. Becomes `$creator` on every Arkiv write. */
  sessionKey: Hex;
  /** Capability tag — `keccak256("arkiv.write")` for the standard write scope. */
  scope: Hex;
  /** Restricts the session to a single Arkiv subtree. */
  entityNamespace: Hex;
  /** Hard cap on Arkiv write count over the session. */
  maxWrites: bigint;
  /** NEW — cumulative GLM ceiling (wei). Relayer refuses writes past this. */
  maxGasWei: bigint;
  /** NEW — when remaining ≤ threshold the dashboard fires a refill alert. */
  refillThresholdWei: bigint;
  /** NEW — master's projected daily burn (display-only, not enforced). */
  estimatedDailyCostWei: bigint;
  /** Unix seconds — earliest moment the relayer may submit a write. */
  validAfter: bigint;
  /** Unix seconds — latest moment a write under this auth is accepted. */
  validBefore: bigint;
  /** Random 32-byte nonce. Burning it cancels the session out-of-order. */
  nonce: Hex;
}

/**
 * EIP-712 type definitions for V2. The struct name (`SessionAuthorizationV2`)
 * makes the typeHash differ from V1, so signatures cannot cross over.
 */
export const SESSION_AUTHORIZATION_V2_TYPES = {
  SessionAuthorizationV2: [
    { name: "user", type: "address" },
    { name: "sessionKey", type: "address" },
    { name: "scope", type: "bytes32" },
    { name: "entityNamespace", type: "bytes32" },
    { name: "maxWrites", type: "uint256" },
    { name: "maxGasWei", type: "uint256" },
    { name: "refillThresholdWei", type: "uint256" },
    { name: "estimatedDailyCostWei", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** Re-export under the name the spec uses. */
export const SESSION_AUTHORIZATION_V2_TYPE = SESSION_AUTHORIZATION_V2_TYPES;

export interface SessionAuthorizationV2TypedData {
  domain: TypedDataDomain;
  types: typeof SESSION_AUTHORIZATION_V2_TYPES;
  primaryType: "SessionAuthorizationV2";
  message: SessionAuthorizationV2;
}

/**
 * Returns the full typed-data payload for a V2 SessionAuthorization. Same
 * shape as the V1 helper — hand straight to a viem signer.
 */
export function getSessionAuthorizationV2TypedData(
  authorization: SessionAuthorizationV2,
): SessionAuthorizationV2TypedData {
  return {
    domain: CORTEX_EIP712_DOMAIN,
    types: SESSION_AUTHORIZATION_V2_TYPES,
    primaryType: "SessionAuthorizationV2",
    message: authorization,
  };
}

/**
 * Computes the EIP-712 digest for a V2 SessionAuthorization. Same domain
 * as V1, but the struct typeHash differs (because the type name + field
 * list differ), so the final digest is V2-only.
 */
export function hashSessionAuthorizationV2(
  authorization: SessionAuthorizationV2,
): Hex {
  return hashTypedData(getSessionAuthorizationV2TypedData(authorization));
}
