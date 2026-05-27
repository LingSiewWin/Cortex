/**
 * Cortex — Braga write preflight (gas, nonce, balance).
 *
 * Pattern from Arkiv MetaMask sketch + official SDK wallet flow: estimate the
 * Arkiv precompile call before asking the user to sign, and surface actionable
 * errors (faucet link, stuck nonce) instead of hanging spinners.
 */

import {
  createPublicClient,
  formatEther,
  http,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import type { CreateEntityParameters } from "@arkiv-network/sdk";
import type { TxParams } from "@arkiv-network/sdk";
import { braga } from "@arkiv-network/sdk/chains";
import { BRAGA } from "../constants";
import { ARKIV_SYSTEM_ADDRESS, encodeCreateEntityCalldata } from "./arkiv-encode";

const FALLBACK_GAS = 800_000n;
const GAS_BUFFER_PCT = 150n;
const FEE_BUFFER_PCT = 150n;
const BALANCE_HEADROOM_PCT = 200n;

let _public: PublicClient | null = null;

function getBragaPublic(): PublicClient {
  if (!_public) {
    _public = createPublicClient({
      chain: braga,
      transport: http(process.env.CORTEX_BRAGA_RPC ?? BRAGA.httpRpc, {
        timeout: 60_000,
        retryCount: 2,
      }),
    });
  }
  return _public;
}

export type BragaWriteEstimate = {
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  maxCostWei: bigint;
  recommendedMinWei: bigint;
};

export async function estimateBragaWriteCost(
  createParams: CreateEntityParameters,
): Promise<BragaWriteEstimate> {
  const calldata = await encodeCreateEntityCalldata(createParams);
  const bragaPublic = getBragaPublic();
  const fees = await bragaPublic.estimateFeesPerGas();

  let gas = FALLBACK_GAS;
  try {
    gas = await bragaPublic.estimateGas({
      to: ARKIV_SYSTEM_ADDRESS,
      value: 0n,
      data: calldata,
    });
    if (gas < 100_000n) gas = FALLBACK_GAS;
  } catch {
    /* fallback */
  }

  const bufferedGas = (gas * GAS_BUFFER_PCT) / 100n;
  const maxFeePerGas = ((fees.maxFeePerGas ?? 1_000_000_000n) * FEE_BUFFER_PCT) / 100n;
  const maxPriorityFeePerGas =
    ((fees.maxPriorityFeePerGas ?? 1_000_000n) * FEE_BUFFER_PCT) / 100n;
  const maxCostWei = bufferedGas * maxFeePerGas;
  const recommendedMinWei = (maxCostWei * BALANCE_HEADROOM_PCT) / 100n;

  return {
    gas: bufferedGas,
    maxFeePerGas,
    maxPriorityFeePerGas,
    maxCostWei,
    recommendedMinWei,
  };
}

export function txParamsFromEstimate(estimate: BragaWriteEstimate): TxParams {
  return {
    gas: estimate.gas,
    maxFeePerGas: estimate.maxFeePerGas,
    maxPriorityFeePerGas: estimate.maxPriorityFeePerGas,
  };
}

export async function assertBragaNonceReady(owner: Address): Promise<void> {
  const bragaPublic = getBragaPublic();
  const [latest, pending] = await Promise.all([
    bragaPublic.getTransactionCount({ address: owner, blockTag: "latest" }),
    bragaPublic.getTransactionCount({ address: owner, blockTag: "pending" }),
  ]);
  if (pending > latest) {
    throw new Error(
      `Pending Braga transaction (nonce ${latest} stuck; wallet shows ${pending}). ` +
        `Cancel or speed up in your wallet, wait ~1 minute, then retry.`,
    );
  }
}

export async function assertBragaFundedForWrite(
  owner: Address,
  createParams: CreateEntityParameters,
): Promise<BragaWriteEstimate> {
  await assertBragaNonceReady(owner);
  const balance = await getBragaPublic().getBalance({ address: owner });
  const estimate = await estimateBragaWriteCost(createParams);

  if (balance < estimate.maxCostWei) {
    throw new Error(
      `Insufficient GLM on Braga (balance ${formatEther(balance)} GLM, ` +
        `need ~${formatEther(estimate.maxCostWei)} GLM for gas). ` +
        `Fund: ${BRAGA.faucet}`,
    );
  }

  return estimate;
}

/** Pull a useful message from viem / Arkiv error chains for UI display. */
export function formatBragaError(error: unknown): string {
  const parts: string[] = [];
  let cur: unknown = error;
  const seen = new Set<unknown>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    if (cur instanceof Error) {
      if (cur.message && !parts.includes(cur.message)) parts.push(cur.message);
      const x = cur as Error & { details?: string; shortMessage?: string };
      if (x.details && !parts.includes(x.details)) parts.push(x.details);
      if (x.shortMessage && !parts.includes(x.shortMessage)) parts.push(x.shortMessage);
      cur = x.cause;
    } else break;
  }
  const combined = parts.join(" — ");
  if (/replacement transaction underpriced/i.test(combined)) {
    return "Stuck pending Braga tx — cancel or speed up in your wallet, then retry.";
  }
  if (/rejected|denied|cancelled/i.test(combined)) {
    return "Transaction rejected in wallet.";
  }
  if (/insufficient|funds|balance|GLM/i.test(combined)) {
    return (
      `${combined} ` +
      `On Braga, GLM is the native gas coin (not an ERC-20 token list entry). ` +
      `In MetaMask, switch to the Braga network (chain ${BRAGA.chainId}) — your L3/explorer balance is only spendable there. ` +
      `Fund: ${BRAGA.faucet}`
    );
  }
  return combined || "Braga transaction failed — switch to Braga testnet and retry.";
}

export { getBragaPublic, ARKIV_SYSTEM_ADDRESS };
