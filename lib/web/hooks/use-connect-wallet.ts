"use client";

import { useCallback, useState } from "react";
import { useConnect, useConnectors } from "wagmi";
import { useAppKit } from "@reown/appkit/react";
import { isWalletConnectConfigured } from "../config";

function pickInjectedConnector(connectors: ReturnType<typeof useConnectors>) {
  return (
    connectors.find((c) => c.id === "injected") ??
    connectors.find((c) => c.type === "injected") ??
    connectors[0]
  );
}

/**
 * Is an injected wallet ACTUALLY present in this browser? A configured `injected`
 * connector always exists in wagmi even with no extension installed, so connecting
 * to it throws a raw `ProviderNotFoundError`. We detect the real provider first so
 * we can show actionable guidance instead — the bug a mobile / no-extension visitor hit.
 */
async function hasInjectedProvider(
  connector: { getProvider?: () => Promise<unknown> } | undefined,
): Promise<boolean> {
  // Fast path: MetaMask / Rabby inject window.ethereum.
  if (typeof window !== "undefined" && (window as { ethereum?: unknown }).ethereum) return true;
  // EIP-6963 wallets surface a provider via the connector even without window.ethereum.
  try {
    return !!(await connector?.getProvider?.());
  } catch {
    return false;
  }
}

const NO_WALLET_MESSAGE =
  "No browser wallet detected. On desktop, install MetaMask or Rabby and refresh. " +
  "On mobile, open this page inside your wallet app's in-app browser. " +
  "(A free WalletConnect projectId enables QR + mobile connect for everyone — see the README.)";

export function useConnectWallet() {
  const { open } = useAppKit();
  const { connectAsync, connectors, isPending, error } = useConnect();
  // Our own channel for pre-flight guidance: a thrown error from the click handler
  // is void-discarded and never reaches the UI, and wagmi's `error` only covers
  // calls that actually reached a connector (i.e. the raw ProviderNotFoundError).
  const [localError, setLocalError] = useState<string | null>(null);

  const connectBrowserWallet = useCallback(async () => {
    setLocalError(null);
    const injected = pickInjectedConnector(connectors);
    if (!injected || !(await hasInjectedProvider(injected))) {
      setLocalError(NO_WALLET_MESSAGE);
      return;
    }
    await connectAsync({ connector: injected });
  }, [connectors, connectAsync]);

  const connectWallet = useCallback(async () => {
    if (!isWalletConnectConfigured()) {
      await connectBrowserWallet();
      return;
    }
    open({ view: "Connect" });
  }, [connectBrowserWallet, open]);

  const openWalletModal = useCallback(() => {
    if (!isWalletConnectConfigured()) return connectBrowserWallet();
    open();
  }, [connectBrowserWallet, open]);

  return {
    connectWallet,
    openWalletModal,
    isPending,
    error: localError ?? error?.message ?? null,
  };
}
