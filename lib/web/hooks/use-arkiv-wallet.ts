"use client";

import { useMemo } from "react";
import { useAccount, useWalletClient } from "wagmi";
import { bragaChain } from "../wagmi";
import { createBrowserArkivWallet } from "@/src/lib/browser-arkiv-wallet";

export function useArkivWallet() {
  const { address, isConnected } = useAccount();
  const { data: wagmiWalletClient } = useWalletClient();

  const arkivWallet = useMemo(() => {
    if (!wagmiWalletClient || !address) return null;
    if (wagmiWalletClient.chain?.id !== bragaChain.id) return null;
    if (!wagmiWalletClient.account) return null;
    return createBrowserArkivWallet(wagmiWalletClient.transport, wagmiWalletClient.account);
  }, [wagmiWalletClient, address]);

  return {
    address,
    isConnected: isConnected && !!address,
    onBraga: wagmiWalletClient?.chain?.id === bragaChain.id,
    arkivWallet,
    wagmiWalletClient,
  };
}
