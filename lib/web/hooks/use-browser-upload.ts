"use client";

import { useCallback, useState } from "react";
import { getWalletClient } from "@wagmi/core";
import { useSwitchChain } from "wagmi";
import type { Hex } from "@/ui/types";
import type { PreparedUpload } from "@/src/lib/store-file-prepare";
import { buildSealedDocumentCreate } from "@/src/lib/browser-store-document";
import { createBrowserArkivWallet } from "@/src/lib/browser-arkiv-wallet";
import {
  assertBragaFundedForWrite,
  formatBragaError,
  txParamsFromEstimate,
} from "@/src/lib/braga-preflight";
import { bragaChain, wagmiConfig } from "../wagmi";
import { useCortexIdentity } from "./use-cortex-identity";

const EXPLORER = "https://explorer.braga.hoodi.arkiv.network";

export type UploadStep = "idle" | "switch" | "adopt" | "prepare" | "sign" | "done" | "error";

export function useBrowserUpload() {
  const { switchChainAsync } = useSwitchChain();
  const identity = useCortexIdentity();
  const [step, setStep] = useState<UploadStep>("idle");
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);

  const upload = useCallback(
    async (file: File, caption?: string) => {
      if (!identity.address) throw new Error("Connect wallet first");
      setError(null);
      setLastTx(null);

      try {
        setStep("switch");
        await switchChainAsync({ chainId: bragaChain.id });

        setStep("adopt");
        const payloadKey = identity.payloadKey ?? (await identity.adopt());

        setStep("prepare");
        const body = new FormData();
        body.set("file", file);
        if (caption?.trim()) body.set("caption", caption.trim());

        const prepRes = await fetch("/api/store-file/prepare", { method: "POST", body });
        const prepJson = (await prepRes.json()) as PreparedUpload & { error?: string };
        if (!prepRes.ok) throw new Error(prepJson.error ?? prepRes.statusText);

        const createParams = await buildSealedDocumentCreate({
          prepared: prepJson,
          payloadKey,
        });

        const wagmiWallet = await getWalletClient(wagmiConfig, { chainId: bragaChain.id });
        if (!wagmiWallet?.account) {
          throw new Error("Wallet not on Braga — open Networks in the wallet modal.");
        }

        const estimate = await assertBragaFundedForWrite(
          wagmiWallet.account.address,
          createParams,
        );

        setStep("sign");
        const arkivWallet = createBrowserArkivWallet(wagmiWallet.transport, wagmiWallet.account);
        const result = await arkivWallet.mutateEntities(
          { creates: [createParams] },
          txParamsFromEstimate(estimate),
        );

        setStep("done");
        setLastTx(result.txHash);
        setStep("idle");
        return {
          txHash: result.txHash as Hex,
          entityKey: result.createdEntities[0] as Hex | undefined,
          explorer: `${EXPLORER}/tx/${result.txHash}`,
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

  return { upload, step, error, lastTx, identity };
}
