/**
 * Cortex — process-scoped owner-identity singleton.
 *
 * Holds the effective owner address + payload-key for the dashboard server
 * process. Resolved from .env on first read (source: "env"), or replaced by
 * the browser's "Connect Wallet" flow (source: "browser") via adopt().
 *
 * Single-user judge scope — the singleton is global to the process. Multi-tenant
 * (per-SIWE-cookie identity) is out-of-scope for this iteration.
 */

import { verifyMessage, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { derivePayloadKey } from "../lib/crypto";
import { keyDerivationMessage } from "../lib/derivation-message";
import { readConfig } from "../lib/cortex-config";

export type IdentitySource = "env" | "browser" | "none";

export interface IdentityView {
  ownerAddress: Hex | null;
  userSignature: Hex | null;
  payloadKey: CryptoKey | null;
  source: IdentitySource;
}

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const PK_RE = /^0x[0-9a-fA-F]{64}$/;
const SIG_RE = /^0x[0-9a-fA-F]+$/;

let _cached: IdentityView | null = null;

async function resolveFromEnv(): Promise<IdentityView> {
  const addr = process.env.USER_PRIMARY_ADDRESS;
  const ownerAddress: Hex | null = addr && ADDR_RE.test(addr) ? (addr as Hex) : null;

  let signature: Hex | null = null;
  const sigEnv = process.env.CORTEX_USER_SIGNATURE;
  if (sigEnv && SIG_RE.test(sigEnv)) {
    signature = sigEnv as Hex;
  } else {
    const pkEnv = process.env.CORTEX_USER_PRIVATE_KEY;
    if (pkEnv && PK_RE.test(pkEnv)) {
      const account = privateKeyToAccount(pkEnv as Hex);
      const message = keyDerivationMessage(account.address);
      signature = (await account.signMessage({ message })) as Hex;
    } else {
      const cfgSig = readConfig()?.userSignature;
      if (cfgSig && SIG_RE.test(cfgSig)) signature = cfgSig as Hex;
    }
  }

  const payloadKey = signature ? await derivePayloadKey(signature) : null;
  const source: IdentitySource = ownerAddress || signature ? "env" : "none";
  return { ownerAddress, userSignature: signature, payloadKey, source };
}

export async function getEffective(): Promise<IdentityView> {
  if (_cached) return _cached;
  _cached = await resolveFromEnv();
  return _cached;
}

export async function adopt(opts: {
  address: Hex;
  signature: Hex;
}): Promise<IdentityView> {
  if (!ADDR_RE.test(opts.address)) {
    throw new Error("adopt: address must be 0x-prefixed 40-hex EOA");
  }
  if (!SIG_RE.test(opts.signature)) {
    throw new Error("adopt: signature must be 0x-prefixed hex");
  }

  const message = keyDerivationMessage(opts.address);
  const ok = await verifyMessage({
    address: opts.address,
    message,
    signature: opts.signature,
  });
  if (!ok) {
    throw new Error("adopt: signature did not verify against address");
  }

  const payloadKey = await derivePayloadKey(opts.signature);
  _cached = {
    ownerAddress: opts.address,
    userSignature: opts.signature,
    payloadKey,
    source: "browser",
  };
  return _cached;
}

/** Test seam: clear the singleton so the next getEffective() re-resolves from env. */
export function _resetOwnerIdentity(): void {
  _cached = null;
}

/** Test seam: force a specific identity (bypasses env + verification). */
export function _setOwnerIdentityForTest(view: IdentityView): void {
  _cached = view;
}

/**
 * Synchronous peek at the cached identity (or null if not resolved yet).
 * Used by callers like getUserPrimaryEOA() that must stay synchronous; only
 * honors an already-resolved view. Returns null before first read; callers
 * fall back to env in that case.
 */
export function _peekCached(): IdentityView | null {
  return _cached;
}
