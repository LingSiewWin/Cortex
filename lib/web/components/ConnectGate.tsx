"use client";

import type { ReactNode } from "react";
import { useAccount } from "wagmi";
import { useConnectWallet } from "../hooks/use-connect-wallet";
import { BRAGA } from "@/src/constants";

export function ConnectGate({
  title = "Connect your wallet",
  lead = "Sign transactions on Arkiv Braga to store memories. Your wallet pays GLM gas — no server session key required for uploads.",
  children,
}: {
  title?: string;
  lead?: string;
  children: ReactNode;
}) {
  const { isConnected } = useAccount();
  const { connectWallet, isPending, error } = useConnectWallet();

  if (isConnected) return <>{children}</>;

  return (
    <div className="connect-gate">
      <div className="connect-gate-inner">
        <p className="connect-gate-kicker mono">Cortex · Arkiv Braga</p>
        <h2 className="connect-gate-title">{title}</h2>
        <p className="connect-gate-lead">{lead}</p>
        <button
          type="button"
          className="connect-gate-btn"
          disabled={isPending}
          onClick={() => void connectWallet()}
        >
          {isPending ? "Connecting…" : "Connect wallet"}
        </button>
        <p className="connect-gate-hint mono">
          Need GLM?{" "}
          <a href={BRAGA.faucet} target="_blank" rel="noreferrer">
            Braga faucet ↗
          </a>
        </p>
        {error ? <p className="connect-gate-err">{error}</p> : null}
      </div>
    </div>
  );
}
