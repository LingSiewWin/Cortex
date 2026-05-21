/**
 * Cortex — ERC-5792 wallet capability probe.
 *
 * Implements §2.4 of docs/ERC.md. Calls `wallet_getCapabilities` via an
 * EIP-1193 provider to learn what the user's wallet can actually do, then
 * lets Cortex degrade gracefully:
 *
 *   - `atomicBatch` true → batch SIWE + session-key in one prompt
 *     (`wallet_sendCalls`).
 *   - `paymasterService` true → could sponsor the SessionAuthorization
 *     tx if Cortex ever needs to. Not used in v1, but the dashboard surfaces it.
 *   - `sessionKeys` true → ERC-7715 native session keys. Won't be true on
 *     Braga today (DelegationManager not deployed — see docs/ERC.md §3.4),
 *     but probing is free and future-proofs the UI.
 *
 * Older wallets (MetaMask <11.x, raw injected providers) return an error
 * for unknown methods. We swallow that error and report all-false rather
 * than letting it bubble up and break the page.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal EIP-1193 request shape. We don't import a full EIP-1193 type so this
 * file works against any provider (wagmi, viem custom, raw `window.ethereum`).
 */
export interface Eip1193Provider {
  request: (args: { method: string; params: unknown[] }) => Promise<unknown>;
}

export interface WalletCaps {
  atomicBatch: boolean;
  paymasterService: boolean;
  /** ERC-7715 native session keys. Won't be true on Braga today. */
  sessionKeys: boolean;
  /** Full response for debugging / surfacing in the dashboard. */
  raw: unknown;
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

/**
 * Probe an EIP-1193 provider for ERC-5792 capabilities. Never throws —
 * returns an all-false result with `raw.error` populated on failure.
 *
 * Response shape per ERC-5792 (`/docs/ERC/erc-knowledge-base/ercs/erc-5792.md`):
 *
 *   {
 *     "0x<chainIdHex>": {
 *        "atomicBatch": { "supported": true },
 *        "paymasterService": { "supported": true },
 *        ...
 *     }
 *   }
 *
 * Some wallets (CB Smart Wallet) return capabilities *without* a chain key
 * — flat at the top level. We handle both shapes.
 */
export async function probeWalletCapabilities(
  provider: Eip1193Provider,
  userAddress: `0x${string}`,
): Promise<WalletCaps> {
  let raw: unknown;
  try {
    raw = await provider.request({
      method: "wallet_getCapabilities",
      params: [userAddress],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      atomicBatch: false,
      paymasterService: false,
      sessionKeys: false,
      raw: { error: message || "not supported" },
    };
  }

  // Both shapes (per-chain map and flat) flatten to the same "is X supported"
  // boolean once we look at the leaves. We accept any chain entry — the
  // dashboard already knows which chain the user is on.
  const buckets: Record<string, unknown>[] = [];
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    // Flat shape: object whose values are { supported: bool }
    if (looksLikeCapabilityBucket(obj)) {
      buckets.push(obj);
    } else {
      // Per-chain shape: { "0x...": { atomicBatch: { supported: bool }, ... } }
      for (const v of Object.values(obj)) {
        if (v && typeof v === "object") {
          buckets.push(v as Record<string, unknown>);
        }
      }
    }
  }

  const atomicBatch = buckets.some((b) => readSupported(b["atomicBatch"]));
  const paymasterService = buckets.some((b) =>
    readSupported(b["paymasterService"]),
  );
  const sessionKeys = buckets.some(
    (b) =>
      readSupported(b["sessionKeys"]) ||
      readSupported(b["permissions"]) /* ERC-7715 variant naming */,
  );

  return { atomicBatch, paymasterService, sessionKeys, raw };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readSupported(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const obj = node as Record<string, unknown>;
  // ERC-5792 standard shape
  if (typeof obj["supported"] === "boolean") return obj["supported"] as boolean;
  // Some wallets emit { status: "supported" }
  if (typeof obj["status"] === "string") {
    return (obj["status"] as string).toLowerCase() === "supported";
  }
  return false;
}

function looksLikeCapabilityBucket(obj: Record<string, unknown>): boolean {
  // A flat capability bucket has known cap keys at the top level. The per-chain
  // wrapper has chain-hex keys ("0x..."), which would never match these names.
  return (
    "atomicBatch" in obj ||
    "paymasterService" in obj ||
    "sessionKeys" in obj ||
    "permissions" in obj
  );
}
