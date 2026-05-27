/**
 * Cortex — ERC-4361 (Sign-In With Ethereum) message builder.
 *
 * Pure builder. No `siwe` / `siwe-viem` dependency:
 *   1. ERC-4361 is a stable, plain-text format — re-implementing the formatter
 *      is ~30 lines and removes a deps-update vector.
 *   2. The verification path uses viem's `verifyMessage` (EIP-191) — already
 *      available transitively. So we never need a SIWE library on the verify
 *      side either.
 *
 * Implements the §2.3 stack from docs/ERC.md. Pairs naturally with the EIP-712
 * SessionAuthorization in `session-key.ts` — SIWE is the human-readable consent,
 * EIP-712 is the structured authorization the relayer enforces.
 *
 * Spec reference: ERC-4361 §3 (Message Format) — exact line ordering is
 * load-bearing for verification by SIWE-aware wallets.
 */

import type { Hex } from "viem";
import { BRAGA } from "../constants";
import { SESSION } from "./../constants";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SiweMessageInput {
  /** Service domain, e.g. "cortex.app" or "localhost:3000". */
  domain: string;
  /** Address the user is signing with. */
  address: Hex;
  /** Human-readable statement — what the user is authorizing. */
  statement: string;
  /** Canonical URI of the requesting service. */
  uri: string;
  /** Chain ID this signature is bound to. */
  chainId: number;
  /** Random nonce — at least 8 alphanumeric chars per ERC-4361. */
  nonce: string;
  /** ISO 8601 timestamp the message was issued. */
  issuedAt: string;
  /** ISO 8601 timestamp after which the signature is no longer valid. */
  expirationTime: string;
  /** Optional resource URIs the user is granting access to. */
  resources?: string[];
}

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

/**
 * Format a SIWE message per ERC-4361 §3. Returns the exact string the user
 * signs — pass to `walletClient.signMessage({ message: formatted })`.
 *
 * Line order (load-bearing — do not reorder):
 *   1. `${domain} wants you to sign in with your Ethereum account:`
 *   2. `${address}`
 *   3. blank
 *   4. `${statement}`   (optional, but Cortex always provides one)
 *   5. blank
 *   6. `URI: ${uri}`
 *   7. `Version: 1`
 *   8. `Chain ID: ${chainId}`
 *   9. `Nonce: ${nonce}`
 *  10. `Issued At: ${issuedAt}`
 *  11. `Expiration Time: ${expirationTime}`  (optional in spec, mandatory in Cortex)
 *  12. `Resources:` + bulleted list           (optional)
 */
export function formatSiweMessage(input: SiweMessageInput): string {
  const lines: string[] = [];
  lines.push(
    `${input.domain} wants you to sign in with your Ethereum account:`,
  );
  lines.push(input.address);
  lines.push("");
  lines.push(input.statement);
  lines.push("");
  lines.push(`URI: ${input.uri}`);
  lines.push(`Version: 1`);
  lines.push(`Chain ID: ${input.chainId}`);
  lines.push(`Nonce: ${input.nonce}`);
  lines.push(`Issued At: ${input.issuedAt}`);
  lines.push(`Expiration Time: ${input.expirationTime}`);
  if (input.resources && input.resources.length > 0) {
    lines.push(`Resources:`);
    for (const r of input.resources) {
      lines.push(`- ${r}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Cortex default builder
// ---------------------------------------------------------------------------

/**
 * Construct the default Cortex SIWE input for a user authorizing a session.
 * Picks up Braga's chain ID and shapes the statement / resources to match the
 * EIP-712 SessionAuthorization the user co-signs immediately after.
 *
 * Domain / URI default to "cortex.app" + "https://cortex.app". The dashboard
 * is expected to override these to its own origin (e.g. "localhost:3000") so
 * the wallet's SIWE-aware check matches the page that requested the signature.
 */
/**
 * Options for the Cortex SIWE builder. `domain` and `uri` are REQUIRED in v1.5+
 * (audit feedback) — hard-coding them to "cortex.app" caused localhost runs to
 * produce signatures that browsers' SIWE checks reject.
 *
 * Pass `domain: window.location.host` and `uri: window.location.origin` from the
 * dashboard, or the production values when deployed.
 */
export interface BuildCortexSiweOptions {
  user: Hex;
  durationSeconds: number;
  maxWrites: number;
  /** Service domain — must match the page that requested the signature. */
  domain: string;
  /** Canonical URI of the requesting service. */
  uri: string;
}

export function buildCortexSiwe(opts: BuildCortexSiweOptions): SiweMessageInput {
  const hours = Math.max(1, Math.round(opts.durationSeconds / 3600));
  const now = new Date();
  const expires = new Date(now.getTime() + opts.durationSeconds * 1000);

  return {
    domain: opts.domain,
    address: opts.user,
    statement: `Authorize Cortex session for ${hours} hours, max ${opts.maxWrites} writes`,
    uri: opts.uri,
    chainId: BRAGA.chainId,
    nonce: randomSiweNonce(),
    issuedAt: now.toISOString(),
    expirationTime: expires.toISOString(),
    // arkiv://cortex/<userAddress-lowercased> — the namespace the relayer is
    // authorized to write to. The dashboard's "What did you sign?" view shows
    // this verbatim so the user can audit it.
    resources: [`arkiv://cortex/${opts.user.toLowerCase()}`],
  };
}

/**
 * Default duration helper — reads from SESSION constants so a single edit
 * propagates. Kept exported because Phase 7 (dashboard) wants it.
 */
export function defaultSiweDurationSeconds(): number {
  return SESSION.defaultValidDurationSeconds;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a SIWE nonce. ERC-4361 requires ≥8 alphanumeric characters; we
 * emit 32 hex chars (16 random bytes → hex) for healthy entropy and a stable,
 * easy-to-parse fixed-length form. Hex is alphanumeric, so it satisfies the
 * spec's character-class requirement without the BigInt / base36 dance.
 */
export function randomSiweNonce(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  let out = "";
  for (const b of buf) out += b.toString(16).padStart(2, "0");
  return out;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * The parsed shape of a SIWE message. Identical to `SiweMessageInput` —
 * `parseSiweMessage` returns the exact fields a caller would have passed to
 * `formatSiweMessage` to reproduce the input. The audit demands we validate
 * every load-bearing field on the server, not just `verifyMessage` on the
 * signature.
 */
export type ParsedSiweMessage = SiweMessageInput;

const FIRST_LINE_RE = /^(?<domain>.+) wants you to sign in with your Ethereum account:$/;
const URI_RE = /^URI: (?<uri>.+)$/;
const VERSION_RE = /^Version: (?<version>.+)$/;
const CHAIN_ID_RE = /^Chain ID: (?<chainId>\d+)$/;
const NONCE_RE = /^Nonce: (?<nonce>[A-Za-z0-9]+)$/;
const ISSUED_AT_RE = /^Issued At: (?<issuedAt>.+)$/;
const EXPIRATION_TIME_RE = /^Expiration Time: (?<expirationTime>.+)$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Parse a SIWE message string back into structured fields. Strict — throws
 * with a useful reason on any deviation from ERC-4361 §3 line ordering.
 *
 * The server uses this to assert the signed message's `chainId`, `domain`,
 * `address`, `nonce`, `uri`, and `expirationTime` match the pending nonce
 * record before trusting the signature. Without this, an attacker who
 * controls the SIWE message body can swap any of those fields and the
 * naïve `verifyMessage(...)` check still passes.
 */
export function parseSiweMessage(raw: string): ParsedSiweMessage {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("SIWE parse error: empty message");
  }
  const lines = raw.split("\n");
  // Minimum lines: 1 first + 1 address + 1 blank + 1 statement + 1 blank
  // + 5 fields (URI/Version/Chain ID/Nonce/Issued At) + 1 expiration = 11.
  if (lines.length < 11) {
    throw new Error("SIWE parse error: too few lines");
  }

  const first = lines[0]!.match(FIRST_LINE_RE);
  if (!first?.groups?.domain) {
    throw new Error("SIWE parse error: malformed preamble line");
  }
  const domain = first.groups.domain;

  const address = lines[1]!;
  if (!ADDRESS_RE.test(address)) {
    throw new Error("SIWE parse error: malformed address line");
  }
  if (lines[2] !== "") {
    throw new Error("SIWE parse error: missing blank after address");
  }
  const statement = lines[3]!;
  if (lines[4] !== "") {
    throw new Error("SIWE parse error: missing blank after statement");
  }

  const uriMatch = lines[5]!.match(URI_RE);
  if (!uriMatch?.groups?.uri) {
    throw new Error("SIWE parse error: missing or malformed URI line");
  }
  const versionMatch = lines[6]!.match(VERSION_RE);
  if (!versionMatch?.groups?.version || versionMatch.groups.version !== "1") {
    throw new Error("SIWE parse error: unsupported version");
  }
  const chainIdMatch = lines[7]!.match(CHAIN_ID_RE);
  if (!chainIdMatch?.groups?.chainId) {
    throw new Error("SIWE parse error: missing or malformed Chain ID");
  }
  const nonceMatch = lines[8]!.match(NONCE_RE);
  if (!nonceMatch?.groups?.nonce) {
    throw new Error("SIWE parse error: missing or malformed Nonce");
  }
  const issuedAtMatch = lines[9]!.match(ISSUED_AT_RE);
  if (!issuedAtMatch?.groups?.issuedAt) {
    throw new Error("SIWE parse error: missing Issued At");
  }
  const expirationMatch = lines[10]!.match(EXPIRATION_TIME_RE);
  if (!expirationMatch?.groups?.expirationTime) {
    throw new Error("SIWE parse error: missing Expiration Time");
  }

  let resources: string[] | undefined;
  if (lines.length > 11) {
    if (lines[11] !== "Resources:") {
      throw new Error("SIWE parse error: unexpected content after Expiration Time");
    }
    resources = [];
    for (let i = 12; i < lines.length; i++) {
      const r = lines[i]!;
      if (!r.startsWith("- ")) {
        throw new Error("SIWE parse error: malformed Resources entry");
      }
      resources.push(r.slice(2));
    }
  }

  const issuedAt = issuedAtMatch.groups.issuedAt;
  const expirationTime = expirationMatch.groups.expirationTime;
  if (!Number.isFinite(Date.parse(issuedAt))) {
    throw new Error("SIWE parse error: invalid Issued At timestamp");
  }
  if (!Number.isFinite(Date.parse(expirationTime))) {
    throw new Error("SIWE parse error: invalid Expiration Time timestamp");
  }

  return {
    domain,
    address: address as Hex,
    statement,
    uri: uriMatch.groups.uri,
    chainId: Number(chainIdMatch.groups.chainId),
    nonce: nonceMatch.groups.nonce,
    issuedAt,
    expirationTime,
    ...(resources ? { resources } : {}),
  };
}
