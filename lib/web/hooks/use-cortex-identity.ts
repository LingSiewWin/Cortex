"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount, useSignMessage, useSwitchChain } from "wagmi";
import type { Hex } from "@/ui/types";
import { keyDerivationMessage } from "@/src/lib/derivation-message";
import { derivePayloadKey } from "@/src/lib/crypto";
import { bragaChain } from "../wagmi";

export interface CortexIdentityState {
  adopted: boolean;
  payloadKey: CryptoKey | null;
  uploadBlockers: string[];
  uploadReady: boolean;
}

export function useCortexIdentity() {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { switchChainAsync } = useSwitchChain();
  const [payloadKey, setPayloadKey] = useState<CryptoKey | null>(null);
  const [adopted, setAdopted] = useState(false);
  const [uploadBlockers, setUploadBlockers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const adoptFor = useRef<string | null>(null);

  const refreshServerAuth = useCallback(async () => {
    const r = await fetch("/api/auth/me");
    if (!r.ok) return;
    const me = (await r.json()) as {
      uploadBlockers?: string[];
      source?: string;
      ownerAddress?: Hex | null;
    };
    setUploadBlockers(me.uploadBlockers ?? []);
    if (me.source === "browser") setAdopted(true);
    if (
      address &&
      me.ownerAddress &&
      me.ownerAddress.toLowerCase() === address.toLowerCase() &&
      me.source === "browser"
    ) {
      adoptFor.current = address.toLowerCase();
    }
  }, [address]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        await refreshServerAuth();
      } catch {
        /* offline */
      }
      if (!alive) return;
    })();
    return () => {
      alive = false;
    };
  }, [address, refreshServerAuth]);

  const ensureBraga = useCallback(async () => {
    try {
      await switchChainAsync({ chainId: bragaChain.id });
    } catch {
      throw new Error("Switch your wallet to Arkiv Braga testnet, then retry.");
    }
  }, [switchChainAsync]);

  const adopt = useCallback(async () => {
    if (!address) throw new Error("Connect wallet first");
    if (adoptFor.current === address.toLowerCase() && payloadKey) return payloadKey;

    setBusy(true);
    setError(null);
    try {
      await ensureBraga();
      const message = keyDerivationMessage(address);
      const signature = await signMessageAsync({ message });
      const res = await fetch("/api/auth/adopt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, signature }),
      });
      if (!res.ok) {
        throw new Error(await res.text());
      }
      const key = await derivePayloadKey(signature as Hex);
      adoptFor.current = address.toLowerCase();
      setPayloadKey(key);
      setAdopted(true);
      await refreshServerAuth();
      return key;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      throw e;
    } finally {
      setBusy(false);
    }
  }, [address, ensureBraga, payloadKey, refreshServerAuth, signMessageAsync]);

  const uploadReady =
    isConnected &&
    !!address &&
    adopted &&
    !!payloadKey &&
    uploadBlockers.length === 0;

  return {
    address: address as Hex | undefined,
    isConnected,
    adopted,
    payloadKey,
    uploadReady,
    uploadBlockers,
    busy,
    error,
    ensureBraga,
    adopt,
  };
}
