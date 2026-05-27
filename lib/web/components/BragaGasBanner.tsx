"use client";

import { BRAGA } from "@/src/constants";
import { braga } from "@arkiv-network/sdk/chains";
import { useBragaGas } from "../hooks/use-braga-gas";

/**
 * Shows GLM from MetaMask's provider (same RPC the sign popup uses).
 */
export function BragaGasBanner() {
  const gas = useBragaGas();

  if (!gas.isConnected) return null;

  const wrongNetwork = gas.rpcMismatch || !gas.onBraga;

  return (
    <div
      className={`braga-gas-banner${wrongNetwork || gas.lowBalance ? " braga-gas-banner-warn" : ""}`}
      role="status"
    >
      <p className="braga-gas-banner-title mono">MetaMask Braga balance (signing RPC)</p>
      <p className="braga-gas-banner-body">
        {gas.isLoading ? (
          "Reading balance from your wallet provider…"
        ) : (
          <>
            <strong>{gas.providerGlm ?? "?"} GLM</strong> for{" "}
            <span className="mono">{gas.address?.slice(0, 6)}…{gas.address?.slice(-4)}</span>
            {gas.onBraga ? (
              <span> · chain <span className="mono">{gas.providerChainId}</span> (Braga)</span>
            ) : (
              <span>
                {" "}
                · wallet reports chain <span className="mono">{gas.providerChainId ?? "?"}</span>{" "}
                (need <span className="mono">{gas.bragaChainId}</span>)
              </span>
            )}
          </>
        )}
      </p>

      {wrongNetwork ? (
        <p className="braga-gas-banner-alert">
          Your MetaMask network does not match Arkiv Braga. Edit the network: Chain ID{" "}
          <span className="mono">{braga.id}</span>, RPC{" "}
          <span className="mono">{gas.bragaRpc}</span>, symbol GLM. A custom “Braga” or
          “Hackathon” entry with the wrong chain ID will show <strong>0 GLM</strong> and block
          signing even if the explorer shows a balance elsewhere.
        </p>
      ) : null}

      {!wrongNetwork && gas.lowBalance ? (
        <p className="braga-gas-banner-alert">
          Provider balance is low for uploads.{" "}
          <a href={BRAGA.faucet} target="_blank" rel="noreferrer">
            Braga faucet ↗
          </a>
        </p>
      ) : null}

      {!wrongNetwork && !gas.lowBalance && gas.onBraga ? (
        <p className="braga-gas-banner-note">
          This is the same RPC MetaMask uses for the fee line in the sign popup — not an ERC-20
          token list entry.
        </p>
      ) : null}
    </div>
  );
}
