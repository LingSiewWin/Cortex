/**
 * Cortex — the `cortex auth` connect page, rebuilt on RainbowKit.
 *
 * Served by scripts/cortex-auth.ts on 127.0.0.1:<ephemeral>. The CLI generates a
 * session keypair, opens this page, the user connects a wallet via RainbowKit and
 * signs ONE message; we POST {address, signature} to /callback, which verifies the
 * signature recovers to the address (over the canonical keyDerivationMessage) and
 * writes ~/.cortex/config.json.
 *
 * Why RainbowKit (not hand-rolled EIP-1193): multiple installed extensions fight
 * over window.ethereum and the hand-rolled flow broke. RainbowKit uses wagmi's
 * EIP-6963 discovery + a trusted modal — the standard an AI×web3 dev would reach for.
 *
 * The message we sign is imported from src/lib/derivation-message (the SAME builder
 * the callback verifies) — never re-typed here, or the derived key would drift.
 *
 * INJECTED-ONLY (no WalletConnect): `cortex auth` runs on the same machine as your
 * wallet extension, so WalletConnect-QR (scan-with-phone) is pointless here.
 * Dropping it also keeps the client bundle free of WalletConnect's Node-only deps
 * (qrcode / xmlhttprequest-ssl), which the standalone browser build rejects.
 * EIP-6963 discovery (via wagmi's `injected` connector) surfaces every installed
 * extension — MetaMask, Rabby, Backpack — in the RainbowKit modal.
 *
 * `state` is read from the URL the CLI opened (?state=…).
 */

import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useSignMessage } from "wagmi";
import { CortexWalletProvider } from "../wallet/CortexWalletProvider";
import { keyDerivationMessage } from "../../src/lib/derivation-message";

const qs = new URLSearchParams(window.location.search);
const STATE = qs.get("state") ?? "";

type Phase = "connect" | "signing" | "done" | "error";

function ConnectAndSign() {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [phase, setPhase] = useState<Phase>("connect");
  const [error, setError] = useState<string>("");
  const [provider, setProvider] = useState("openai");
  const [embeddingKey, setEmbeddingKey] = useState("");

  async function finish() {
    if (!address) return;
    setPhase("signing");
    setError("");
    try {
      // Sign the EXACT canonical message the callback re-derives + verifies.
      const message = keyDerivationMessage(address);
      const signature = await signMessageAsync({ message });
      const res = await fetch("/callback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          address,
          signature,
          state: STATE,
          embeddingKey: embeddingKey.trim() || undefined,
          embeddingProvider: provider,
        }),
      });
      if (!res.ok) throw new Error(`Local app rejected the signature (${res.status}).`);
      setPhase("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  if (phase === "done") {
    return (
      <p className="ok">
        ✓ Connected as {address?.slice(0, 6)}…{address?.slice(-4)}. Return to your
        terminal — you can close this tab.
      </p>
    );
  }

  return (
    <>
      <div className="connect-row">
        <ConnectButton
          showBalance={false}
          accountStatus="address"
          chainStatus="icon"
        />
      </div>

      {isConnected && (
        <>
          <div className="field">
            <label htmlFor="prov">Embedding key (optional, stored locally)</label>
            <select id="prov" value={provider} onChange={(e) => setProvider(e.target.value)}>
              <option value="openai">OpenAI</option>
              <option value="openrouter">OpenRouter</option>
              <option value="voyage">Voyage (Claude/Anthropic ecosystem)</option>
              <option value="cohere">Cohere</option>
            </select>
            <input
              type="password"
              autoComplete="off"
              placeholder="sk-…  (leave blank to set later)"
              value={embeddingKey}
              onChange={(e) => setEmbeddingKey(e.target.value)}
            />
          </div>
          <button className="primary" disabled={phase === "signing"} onClick={finish}>
            {phase === "signing" ? "Check your wallet — signing…" : "Sign to finish setup"}
          </button>
        </>
      )}

      {phase === "error" && <div className="err">{error}</div>}
    </>
  );
}

function App() {
  return (
    <CortexWalletProvider>
      <div className="card">
        <h1>Connect Cortex</h1>
        <p>
          Sign once to derive your memory's encryption key. Your wallet key never
          leaves your browser — only the signature is sent, to this local app on
          your machine.
        </p>
        <ConnectAndSign />
      </div>
    </CortexWalletProvider>
  );
}

const STYLE = `
  :root { color-scheme: dark; }
  body {
    font: 15px -apple-system, system-ui, sans-serif; margin: 0;
    background: #0a0a0a; color: #f5f5f7;
    display: flex; min-height: 100vh; align-items: center; justify-content: center;
  }
  .card {
    background: #141414; border: 1px solid rgba(255,255,255,.1); border-radius: 16px;
    padding: 32px; max-width: 460px; width: 100%;
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p { color: #a0a0a8; line-height: 1.5; font-size: 13.5px; }
  .connect-row { margin: 20px 0 4px; }
  .field { margin-top: 18px; }
  label { font-size: 12px; color: #8b8b92; text-transform: uppercase; letter-spacing: .05em; }
  select, input {
    font: inherit; width: 100%; box-sizing: border-box; margin-top: 8px;
    background: #0c0c0c; color: #f5f5f7; border: 1px solid rgba(255,255,255,.14);
    border-radius: 10px; padding: 11px;
  }
  button.primary {
    font: inherit; font-weight: 600; width: 100%; margin-top: 14px; cursor: pointer;
    background: #0055ff; color: #fff; border: 0; border-radius: 10px; padding: 12px 18px;
  }
  button.primary:disabled { opacity: .5; cursor: default; }
  .ok { color: #00d27a; font-weight: 600; }
  .err { color: #ff5a5a; font-size: 12.5px; margin-top: 10px; }
`;

const styleEl = document.createElement("style");
styleEl.textContent = STYLE;
document.head.appendChild(styleEl);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
