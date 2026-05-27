"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, useChainId, useWalletClient } from "wagmi";
import { formatEther } from "viem";
import { bragaChain } from "../wagmi";
import { readBragaProviderSnapshot } from "../verify-braga-provider";
import { BRAGA } from "@/src/constants";

const LOW_BALANCE_WEI = 500_000_000_000_000n;

export function useBragaGas() {
  const { address, isConnected } = useAccount();
  const activeChainId = useChainId();
  const { data: walletClient } = useWalletClient();
  const [providerChainId, setProviderChainId] = useState<number | null>(null);
  const [providerWei, setProviderWei] = useState<bigint | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!isConnected || !address || !walletClient) {
      setProviderChainId(null);
      setProviderWei(null);
      return;
    }
    setIsLoading(true);
    try {
      const snap = await readBragaProviderSnapshot(walletClient, address);
      setProviderChainId(snap.chainId);
      setProviderWei(snap.balanceWei);
    } catch {
      setProviderChainId(null);
      setProviderWei(null);
    } finally {
      setIsLoading(false);
    }
  }, [address, isConnected, walletClient]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onBraga = providerChainId === bragaChain.id;
  const wagmiOnBraga = activeChainId === bragaChain.id;
  const providerGlm =
    providerWei !== null ? formatEther(providerWei) : null;
  const rpcMismatch =
    providerChainId !== null && providerChainId !== bragaChain.id;
  const lowBalance =
    providerWei !== null && providerWei < LOW_BALANCE_WEI && onBraga;

  return {
    isConnected,
    address,
    onBraga,
    wagmiOnBraga,
    rpcMismatch,
    activeChainId,
    providerChainId,
    bragaChainId: bragaChain.id,
    bragaRpc: BRAGA.httpRpc,
    providerGlm,
    bragaWei: providerWei ?? 0n,
    lowBalance,
    isLoading,
    refresh,
  };
}
