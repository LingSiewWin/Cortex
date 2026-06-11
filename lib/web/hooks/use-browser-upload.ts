"use client";

import { useCallback, useState } from "react";
import { getChainId, getWalletClient, waitForTransactionReceipt } from "@wagmi/core";
import { useSwitchChain } from "wagmi";
import { formatEther, formatGwei } from "viem";
import type { Hex } from "@/ui/types";
import type { PreparedUploadResponse } from "@/lib/web/types/upload-quote";
import { buildSealedDocumentCreate } from "@/src/lib/browser-store-document";
import { createBrowserArkivWallet } from "@/src/lib/browser-arkiv-wallet";
import {
  assertBragaFundedForWrite,
  formatBragaError,
  txParamsFromEstimate,
} from "@/src/lib/braga-preflight";
import { ensureBragaNetwork } from "../ensure-braga";
import { assertBragaProviderReady } from "../verify-braga-provider";
import { bragaChain, wagmiConfig } from "../wagmi";
import { useCortexIdentity } from "./use-cortex-identity";

const EXPLORER = "https://explorer.braga.hoodi.arkiv.network";

export type UploadStep = "idle" | "switch" | "adopt" | "prepare" | "sign" | "done" | "error";

/**
 * MEASURED gas of a confirmed write — read from the on-chain receipt
 * (`gasUsed × effectiveGasPrice`), NOT the pre-sign estimate. This is the proof
 * that the user's own wallet burned real Braga GLM per write: the number on the
 * receipt is the same one the block explorer shows, derived independently of any
 * Cortex code path.
 */
export interface GasReceipt {
  /** Gas units actually consumed. */
  gasUsed: string;
  /** Effective gas price in gwei. */
  effectiveGasPriceGwei: string;
  /** Fee in wei (gasUsed × effectiveGasPrice), as a decimal string. */
  feeWei: string;
  /** Fee formatted in whole GLM (ether units) for display. */
  feeGlm: string;
}

export function useBrowserUpload() {
  const { switchChainAsync } = useSwitchChain();
  const identity = useCortexIdentity();
  const [step, setStep] = useState<UploadStep>("idle");
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);
  const [lastEntityKey, setLastEntityKey] = useState<Hex | null>(null);
  const [lastGas, setLastGas] = useState<GasReceipt | null>(null);

  const upload = useCallback(
    async (
      file: File,
      caption?: string,
      opts?: { prepared?: PreparedUploadResponse },
    ) => {
      if (!identity.address) throw new Error("Connect wallet first");
      setError(null);
      setLastTx(null);
      setLastEntityKey(null);
      setLastGas(null);

      try {
        setStep("switch");
        await switchChainAsync({ chainId: bragaChain.id });

        setStep("adopt");
        const payloadKey = identity.payloadKey ?? (await identity.adopt());

        let prepJson = opts?.prepared;
        if (!prepJson) {
          setStep("prepare");
          const body = new FormData();
          body.set("file", file);
          if (caption?.trim()) body.set("caption", caption.trim());
          const ownerQ = `?owner=${encodeURIComponent(identity.address)}`;
          const prepRes = await fetch(`/api/store-file/prepare${ownerQ}`, {
            method: "POST",
            body,
          });
          prepJson = (await prepRes.json()) as PreparedUploadResponse & { error?: string };
          if (!prepRes.ok) throw new Error((prepJson as { error?: string }).error ?? prepRes.statusText);
        }

        const createParams = await buildSealedDocumentCreate({
          prepared: prepJson,
          payloadKey,
        });

        const wagmiWallet = await getWalletClient(wagmiConfig, { chainId: bragaChain.id });
        if (!wagmiWallet?.account) {
          throw new Error("Wallet not connected — reconnect in the header.");
        }

        await ensureBragaNetwork(wagmiWallet);
        const chainId = await getChainId(wagmiConfig);
        if (Number(chainId) !== Number(bragaChain.id)) {
          throw new Error(
            `Wallet must be on Arkiv Braga (chain ${bragaChain.id}) before signing. ` +
              `In MetaMask, pick Braga from the network menu — GLM gas does not appear on Ethereum.`,
          );
        }

        const estimate = await assertBragaFundedForWrite(
          wagmiWallet.account.address,
          createParams,
        );

        await assertBragaProviderReady(
          wagmiWallet,
          wagmiWallet.account.address,
          estimate.maxCostWei,
        );

        setStep("sign");
        const arkivWallet = createBrowserArkivWallet(wagmiWallet.transport, wagmiWallet.account);
        const result = await arkivWallet.mutateEntities(
          { creates: [createParams] },
          txParamsFromEstimate(estimate),
        );

        const entityKey = result.createdEntities[0] as Hex | undefined;

        // Read the on-chain receipt for the MEASURED fee (gasUsed ×
        // effectiveGasPrice). Best-effort: the tx already landed, so a slow/flaky
        // receipt read must not fail the upload — it only enriches the proof.
        let gas: GasReceipt | null = null;
        try {
          const receipt = await waitForTransactionReceipt(wagmiConfig, {
            hash: result.txHash as Hex,
            chainId: bragaChain.id,
          });
          const feeWei = receipt.gasUsed * receipt.effectiveGasPrice;
          gas = {
            gasUsed: receipt.gasUsed.toString(),
            effectiveGasPriceGwei: formatGwei(receipt.effectiveGasPrice),
            feeWei: feeWei.toString(),
            feeGlm: formatEther(feeWei),
          };
          setLastGas(gas);
        } catch {
          /* receipt read is best-effort; the write itself is already confirmed */
        }

        if (entityKey) {
          try {
            await fetch("/api/memories/register", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ entityKey, txHash: result.txHash }),
            });
          } catch {
            /* mirror catch-up is best-effort; topology refetches on next poll */
          }
        }

        setStep("done");
        setLastTx(result.txHash);
        setLastEntityKey(entityKey ?? null);
        setStep("idle");
        return {
          txHash: result.txHash as Hex,
          entityKey,
          explorer: `${EXPLORER}/tx/${result.txHash}`,
          gas,
        };
      } catch (e) {
        setStep("error");
        const msg = formatBragaError(e);
        setError(msg);
        setStep("idle");
        throw new Error(msg);
      }
    },
    [identity, switchChainAsync],
  );

  return { upload, step, error, lastTx, lastEntityKey, lastGas, identity };
}
