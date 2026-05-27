"use client";

import { useAccount } from "wagmi";
import { useConnectWallet } from "../hooks/use-connect-wallet";

export function WalletHeader() {
  const { address, isConnected } = useAccount();
  const { connectWallet, openWalletModal, isPending } = useConnectWallet();

  if (!isConnected || !address) {
    return (
      <button
        type="button"
        className="wallet-header-btn"
        disabled={isPending}
        onClick={() => void connectWallet()}
      >
        {isPending ? "Connecting…" : "Connect"}
      </button>
    );
  }

  return (
    <button
      type="button"
      className="wallet-header-pill mono"
      title={address}
      onClick={() => void openWalletModal()}
    >
      {address.slice(0, 6)}…{address.slice(-4)}
    </button>
  );
}
