/**
 * Pre-sign cost estimate for console document uploads.
 *
 * Surfaces what the user is about to commit to before MetaMask opens:
 * sealed payload size, lease duration, Braga tx gas, and Arkiv storage economics.
 */

import type { Address } from "viem";
import { formatEther } from "viem";
import { REINFORCEMENT } from "../constants.ts";
import {
  buildDocumentCreateParams,
  estimatedSealedPayloadBytes,
} from "./document-create-params.ts";
import { estimateBragaWriteCost } from "./braga-preflight.ts";
import type { PreparedUpload } from "./store-file-prepare.ts";

export interface UploadQuote {
  /** Sealed ciphertext size written to Arkiv (bytes). */
  sealedPayloadBytes: number;
  /** CBOR document payload before encryption (bytes). */
  plainPayloadBytes: number;
  /** Source file size on disk (bytes) — may be larger than on-chain payload for images. */
  sourceFileBytes: number;
  binary: boolean;
  /** Initial lease in seconds (document tier default). */
  leaseSeconds: number;
  /** Human lease label, e.g. "1 year". */
  leaseLabel: string;
  /** Approximate calendar expiry from now (Braga ~2s blocks; illustrative). */
  expiresAbout: string;
  /**
   * Arkiv storage economics input: sealed bytes × lease seconds.
   * Official framing: fee scales with bytes × expiration duration.
   */
  storageByteSeconds: string;
  /** Max Braga L2 gas the wallet may spend (wei string). */
  txGasMaxWei: string;
  txGasMaxGlm: string;
  /**
   * Illustrative on-chain storage charge when `ARKIV_STORAGE_WEI_PER_BYTE_SECOND` is set.
   * Null on testnet until Arkiv publishes mainnet rates.
   */
  storageEstimateWei: string | null;
  storageEstimateGlm: string | null;
  /** tx gas + storage estimate (storage omitted when rate unknown). */
  totalEstimateWei: string;
  totalEstimateGlm: string;
  /** What MetaMask will ask the user to approve (execution gas). */
  walletApprovalGlm: string;
  disclaimer: string;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function leaseLabel(seconds: number): string {
  const days = Math.round(seconds / 86400);
  if (days >= 365) return days >= 730 ? `${Math.round(days / 365)} years` : "1 year";
  if (days >= 1) return `${days} days`;
  const hours = Math.round(seconds / 3600);
  if (hours >= 1) return `${hours} hours`;
  return `${seconds} seconds`;
}

function expiresAboutFromNow(leaseSeconds: number): string {
  const d = new Date(Date.now() + leaseSeconds * 1000);
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatGlmFromWei(wei: bigint): string {
  const s = formatEther(wei);
  const n = Number(s);
  if (!Number.isFinite(n) || n === 0) return "0 GLM";
  if (n < 0.0001) return `<0.0001 GLM`;
  if (n < 1) return `${n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")} GLM`;
  return `${n.toFixed(4)} GLM`;
}

function parseStorageRateWei(): bigint | null {
  const raw = process.env.ARKIV_STORAGE_WEI_PER_BYTE_SECOND?.trim();
  if (!raw) return null;
  try {
    const v = BigInt(raw);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

/**
 * Quote a prepared upload. When `owner` is set, includes live Braga gas estimation.
 */
export async function quotePreparedUpload(
  prepared: PreparedUpload,
  opts?: { owner?: Address; sourceFileBytes?: number },
): Promise<UploadQuote> {
  const leaseSeconds = REINFORCEMENT.documentInitialSeconds;
  const { plainBytes, sealedBytes } = estimatedSealedPayloadBytes(prepared);
  const sourceFileBytes = opts?.sourceFileBytes ?? 0;

  // Gas estimate uses correct calldata size (payload content does not affect gas much).
  const payloadPlaceholder = new Uint8Array(sealedBytes);
  const createParams = buildDocumentCreateParams(prepared, payloadPlaceholder);

  const est = await estimateBragaWriteCost(createParams);
  const txGasMaxWei = est.maxCostWei;
  void opts?.owner;

  const storageByteSeconds = BigInt(sealedBytes) * BigInt(leaseSeconds);
  const rate = parseStorageRateWei();
  const storageEstimateWei = rate ? storageByteSeconds * rate : null;
  const totalWei = storageEstimateWei ? txGasMaxWei + storageEstimateWei : txGasMaxWei;

  const disclaimer =
    rate === null
      ? "You pay what MetaMask shows under Network fee (Braga tx gas only on testnet). " +
        "The storage meter is sealed bytes × 1 year — Arkiv’s pricing dimension, not an extra wallet line item until mainnet rates ship. " +
        "We do not add a storage surcharge in Total estimate."
      : "Estimates include Arkiv’s bytes×lease rate (when configured) plus Braga tx gas. " +
        "Your wallet approves one transaction; mined cost may be lower than the max.";

  return {
    sealedPayloadBytes: sealedBytes,
    plainPayloadBytes: plainBytes,
    sourceFileBytes,
    binary: prepared.binary,
    leaseSeconds,
    leaseLabel: leaseLabel(leaseSeconds),
    expiresAbout: expiresAboutFromNow(leaseSeconds),
    storageByteSeconds: storageByteSeconds.toString(),
    txGasMaxWei: txGasMaxWei.toString(),
    txGasMaxGlm: formatGlmFromWei(txGasMaxWei),
    storageEstimateWei: storageEstimateWei?.toString() ?? null,
    storageEstimateGlm: storageEstimateWei ? formatGlmFromWei(storageEstimateWei) : null,
    totalEstimateWei: totalWei.toString(),
    totalEstimateGlm: formatGlmFromWei(totalWei),
    walletApprovalGlm: formatGlmFromWei(txGasMaxWei),
    disclaimer,
  };
}

export { formatBytes };
