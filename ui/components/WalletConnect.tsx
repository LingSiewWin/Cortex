/**
 * Console wallet — now on RainbowKit (unified with the `cortex auth` page).
 *
 * RainbowKit's <ConnectButton> owns connect / wallet-picker / chain-switch / the
 * connected address + chain UI (it uses EIP-6963 discovery under the hood, which
 * is what the old hand-rolled component reimplemented by hand). This component
 * keeps the two console-specific concerns RainbowKit doesn't cover:
 *   1. ERC-5792 `wallet_getCapabilities` probe → the Atomic Batch / Paymaster /
 *      Session-Key tags shown in the topbar.
 *   2. The SIWE init→verify handshake that establishes the console's session
 *      cookie (protected endpoints in ui-server require it).
 * Both run once per connected address, after RainbowKit reports the connection.
 *
 * Must be rendered inside <CortexWalletProvider>.
 */

import { useEffect, useRef, useState } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useSignMessage, useSwitchChain } from "wagmi";
import type { Hex, WalletCapsView } from "../types";
import { bragaChain } from "../wallet/wagmi";

interface Props {
  onConnected?: (address: Hex, caps: WalletCapsView) => void;
}

interface Eip1193Provider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
}

/** ERC-5792 capability probe — tolerant of wallets that don't implement it. */
async function probeCapabilities(provider: Eip1193Provider, account: Hex): Promise<WalletCapsView> {
  const caps: WalletCapsView = { atomicBatch: false, paymasterService: false, sessionKeys: false };
  try {
    const raw = (await provider.request({
      method: "wallet_getCapabilities",
      params: [account],
    })) as Record<string, Record<string, { supported?: boolean }>>;
    for (const bucket of Object.values(raw ?? {})) {
      if (bucket?.atomicBatch?.supported) caps.atomicBatch = true;
      if (bucket?.paymasterService?.supported) caps.paymasterService = true;
      if (bucket?.sessionKeys?.supported) caps.sessionKeys = true;
    }
    const flat = (raw ?? {}) as unknown as Record<string, { supported?: boolean } | undefined>;
    if (flat["atomicBatch"]?.supported) caps.atomicBatch = true;
    if (flat["paymasterService"]?.supported) caps.paymasterService = true;
    if (flat["sessionKeys"]?.supported) caps.sessionKeys = true;
  } catch {
    /* wallet doesn't implement 5792 */
  }
  return caps;
}

export function WalletConnect({ onConnected }: Props) {
  const { address, isConnected, chainId, connector } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { switchChainAsync } = useSwitchChain();

  const [caps, setCaps] = useState<WalletCapsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Guard so the handshake (which prompts a signature) runs once per address —
  // not twice under StrictMode, and not again on unrelated re-renders.
  const handshakeFor = useRef<string | null>(null);

  useEffect(() => {
    if (!isConnected || !address || !connector) return;
    if (handshakeFor.current === address.toLowerCase()) return;
    handshakeFor.current = address.toLowerCase();

    (async () => {
      setError(null);
      try {
        // Best-effort: nudge the wallet onto Braga (wagmi adds it from config).
        if (chainId !== bragaChain.id) {
          try {
            await switchChainAsync({ chainId: bragaChain.id });
          } catch {
            /* user can stay on their chain; signing works regardless */
          }
        }

        const provider = (await connector.getProvider()) as Eip1193Provider;
        const capsView = await probeCapabilities(provider, address as Hex);
        setCaps(capsView);

        // SIWE init → sign → verify (establishes the console session cookie).
        const initRes = await fetch("/api/auth/siwe/init", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            address,
            domain: window.location.host,
            uri: window.location.origin,
          }),
        });
        if (!initRes.ok) throw new Error(`siwe init failed: ${initRes.status}`);
        const { message, nonce } = (await initRes.json()) as { message: string; nonce: string };

        const signature = await signMessageAsync({ message });

        const verifyRes = await fetch("/api/auth/siwe/verify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            nonce,
            signature,
            signer: address,
            message,
            capabilities: capsView,
          }),
        });
        if (!verifyRes.ok) throw new Error(`siwe verify failed: ${await verifyRes.text()}`);

        // Adopt the connected wallet as the agent's owner. One extra signature
        // bootstraps the AES sealing key + re-keys the autonomous loop. If the
        // user rejects this second prompt, SIWE still worked — we degrade
        // gracefully and surface a "sign to adopt" retry on the next reconnect.
        const { keyDerivationMessage } = await import("../../src/lib/derivation-message");
        const derivationMessage = keyDerivationMessage(address);
        let derivationSig: string;
        try {
          derivationSig = await signMessageAsync({ message: derivationMessage });
        } catch {
          setError(
            "Identity not adopted — sign the key-derivation message to enable sealed recall.",
          );
          onConnected?.(address as Hex, capsView);
          return;
        }
        const adoptRes = await fetch("/api/auth/adopt", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ address, signature: derivationSig }),
        });
        if (!adoptRes.ok) {
          setError(`adopt failed: ${await adoptRes.text()}`);
        }

        onConnected?.(address as Hex, capsView);
      } catch (err) {
        // Allow a retry on the next connection attempt.
        handshakeFor.current = null;
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [isConnected, address, connector, chainId, switchChainAsync, signMessageAsync, onConnected]);

  return (
    <div className="right">
      {error ? <span className="tag warn">{error}</span> : null}
      {caps?.atomicBatch ? <span className="tag good">Atomic Batch</span> : null}
      {caps?.paymasterService ? <span className="tag good">Paymaster</span> : null}
      {caps?.sessionKeys ? <span className="tag good">Session Keys</span> : null}
      <ConnectButton showBalance={false} accountStatus="address" chainStatus="icon" />
    </div>
  );
}
