import { useEffect, useRef, useState } from "react";
import type { Hex, WalletCapsView } from "../types";
import { truncateAddress } from "../format";

interface Props {
  onConnected?: (address: Hex, caps: WalletCapsView) => void;
}

interface Eip1193Provider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
}

interface Eip6963ProviderInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}

interface Eip6963ProviderDetail {
  info: Eip6963ProviderInfo;
  provider: Eip1193Provider;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
  interface WindowEventMap {
    "eip6963:announceProvider": CustomEvent<Eip6963ProviderDetail>;
  }
}

type Status =
  | "idle"
  | "connecting"
  | "switching-chain"
  | "signing"
  | "connected"
  | "wrong-chain"
  | "error";

const BRAGA_CHAIN = {
  decId: 60138453102,
  hexId: "0x" + (60138453102).toString(16),
  name: "Arkiv Braga Testnet",
  rpcUrl: "https://braga.hoodi.arkiv.network/rpc",
  explorer: "https://explorer.braga.hoodi.arkiv.network",
  nativeCurrency: { name: "Golem", symbol: "GLM", decimals: 18 },
} as const;

const ERR_CHAIN_NOT_ADDED = 4902;

// ---------------------------------------------------------------------------
// EIP-6963 Multi-Injected Provider Discovery (the real performance fix)
// ---------------------------------------------------------------------------
//
// Why this exists: `window.ethereum` is a single global slot that multiple
// wallet extensions race to claim. When Backpack, Phantom, and MetaMask are
// all installed, the loser still wraps the winner's provider as a fallback —
// adding 200-500ms of latency to every request. EIP-6963 fixes this: wallets
// announce themselves via `eip6963:announceProvider` events with a unique
// RDNS, and the dapp picks one directly. No racing, no wrapping.
//
// The discovery starts the moment this module loads (not on mount) so that
// by the time the user clicks Connect Wallet, providers are already known.
// ---------------------------------------------------------------------------

const providerRegistry: Map<string, Eip6963ProviderDetail> = new Map();

if (typeof window !== "undefined") {
  window.addEventListener("eip6963:announceProvider", (event) => {
    const detail = event.detail;
    if (!detail?.info?.uuid) return;
    providerRegistry.set(detail.info.uuid, detail);
  });
  // Tell wallets to announce. Wallets that follow the spec re-broadcast on
  // every request event, so spamming this is safe.
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

/**
 * Pick the best available EIP-1193 provider:
 *   1. MetaMask (rdns = "io.metamask") if announced
 *   2. Any other EIP-6963 announced provider
 *   3. Fallback to window.ethereum (legacy single-slot)
 */
function pickProvider(): { provider: Eip1193Provider; info: Eip6963ProviderInfo | null } | null {
  // Re-dispatch request — late-arriving wallets get a chance to announce.
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("eip6963:requestProvider"));
  }

  if (providerRegistry.size > 0) {
    const metamask = Array.from(providerRegistry.values()).find(
      (p) => p.info.rdns === "io.metamask",
    );
    if (metamask) {
      return { provider: metamask.provider, info: metamask.info };
    }
    const first = providerRegistry.values().next().value;
    if (first) {
      return { provider: first.provider, info: first.info };
    }
  }

  if (typeof window !== "undefined" && window.ethereum) {
    return { provider: window.ethereum, info: null };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Chain switching
// ---------------------------------------------------------------------------

async function ensureBragaChain(provider: Eip1193Provider): Promise<void> {
  const current = (await provider.request({
    method: "eth_chainId",
    params: [],
  })) as string;
  if (current?.toLowerCase() === BRAGA_CHAIN.hexId.toLowerCase()) return;

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: BRAGA_CHAIN.hexId }],
    });
  } catch (err) {
    const code = (err as { code?: number })?.code;
    const message = (err as { message?: string })?.message ?? "";
    if (
      code === ERR_CHAIN_NOT_ADDED ||
      /unrecognized chain id|chain.*not.*added/i.test(message)
    ) {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: BRAGA_CHAIN.hexId,
            chainName: BRAGA_CHAIN.name,
            nativeCurrency: BRAGA_CHAIN.nativeCurrency,
            rpcUrls: [BRAGA_CHAIN.rpcUrl],
            blockExplorerUrls: [BRAGA_CHAIN.explorer],
          },
        ],
      });
      try {
        await provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: BRAGA_CHAIN.hexId }],
        });
      } catch {
        /* tolerated */
      }
    } else if (code === 4001 || /user rejected/i.test(message)) {
      throw new Error("Chain switch rejected — Cortex requires Braga testnet.");
    } else {
      throw err;
    }
  }
}

async function probeCapabilities(
  provider: Eip1193Provider,
  account: Hex,
): Promise<WalletCapsView> {
  const capsView: WalletCapsView = {
    atomicBatch: false,
    paymasterService: false,
    sessionKeys: false,
  };
  try {
    const raw = (await provider.request({
      method: "wallet_getCapabilities",
      params: [account],
    })) as Record<string, Record<string, { supported?: boolean }>>;
    for (const bucket of Object.values(raw ?? {})) {
      if (bucket?.atomicBatch?.supported) capsView.atomicBatch = true;
      if (bucket?.paymasterService?.supported) capsView.paymasterService = true;
      if (bucket?.sessionKeys?.supported) capsView.sessionKeys = true;
    }
    if (raw && typeof raw === "object") {
      const flat = raw as unknown as Record<
        string,
        { supported?: boolean } | undefined
      >;
      if (flat["atomicBatch"]?.supported) capsView.atomicBatch = true;
      if (flat["paymasterService"]?.supported) capsView.paymasterService = true;
      if (flat["sessionKeys"]?.supported) capsView.sessionKeys = true;
    }
  } catch {
    /* wallet doesn't implement 5792 */
  }
  return capsView;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function WalletConnect({ onConnected }: Props) {
  const [address, setAddress] = useState<Hex | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [caps, setCaps] = useState<WalletCapsView | null>(null);
  const [chainHex, setChainHex] = useState<string | null>(null);
  // The provider we resolved (EIP-6963 preferred). Cached so click handlers
  // don't re-pick. Refreshed when the registry changes (e.g. extension installed).
  const providerRef = useRef<Eip1193Provider | null>(null);
  const [providerName, setProviderName] = useState<string | null>(null);

  // Resolve provider as soon as we mount — EIP-6963 announcements may have
  // already landed before React rendered. Re-dispatch the request to catch
  // late wallets.
  useEffect(() => {
    const picked = pickProvider();
    if (picked) {
      providerRef.current = picked.provider;
      setProviderName(picked.info?.name ?? "Injected wallet");
    }
  }, []);

  // Best-effort silent check on mount — populate state IF the user is already
  // connected (no popup, sub-50ms).
  useEffect(() => {
    const provider = providerRef.current ?? window.ethereum;
    if (!provider) return;
    (async () => {
      try {
        const accounts = (await provider.request({
          method: "eth_accounts",
          params: [],
        })) as string[];
        if (accounts && accounts[0]) setAddress(accounts[0] as Hex);
        const chain = (await provider.request({
          method: "eth_chainId",
          params: [],
        })) as string;
        setChainHex(chain);
      } catch {
        /* wallet locked or unavailable */
      }
    })();
  }, [providerName]);

  // chainChanged / accountsChanged listeners
  useEffect(() => {
    const provider = providerRef.current ?? window.ethereum;
    if (!provider?.on) return;
    const onChain = (...args: unknown[]) => {
      const c = args[0] as string;
      setChainHex(c);
      if (
        status === "connected" &&
        c?.toLowerCase() !== BRAGA_CHAIN.hexId.toLowerCase()
      ) {
        setStatus("wrong-chain");
        setError(`Wrong chain (${parseInt(c, 16)}) — switch to Braga.`);
      }
    };
    const onAccounts = (...args: unknown[]) => {
      const next = args[0] as string[];
      if (!next || next.length === 0) {
        setAddress(null);
        setStatus("idle");
      } else {
        setAddress(next[0] as Hex);
      }
    };
    provider.on("chainChanged", onChain);
    provider.on("accountsChanged", onAccounts);
    return () => {
      provider.removeListener?.("chainChanged", onChain);
      provider.removeListener?.("accountsChanged", onAccounts);
    };
  }, [status, providerName]);

  const connect = async () => {
    setError(null);
    const provider = providerRef.current ?? pickProvider()?.provider ?? null;
    if (!provider) {
      setError("No injected wallet detected. Install MetaMask / Rabby / Frame.");
      setStatus("error");
      return;
    }
    setStatus("connecting");

    try {
      // FAST PATH — if eth_accounts already shows a connection (set by the
      // mount effect), we have permission. Skip eth_requestAccounts entirely;
      // that call adds 200-500ms even when you've already approved this dapp.
      let acct: Hex;
      if (address) {
        // Belt-and-braces: verify the connection is still live with a silent
        // eth_accounts. If MetaMask was disconnected since mount, fall back
        // to the slow request path.
        const live = (await provider.request({
          method: "eth_accounts",
          params: [],
        })) as string[];
        if (live[0]?.toLowerCase() === address.toLowerCase()) {
          acct = address;
        } else {
          const accounts = (await provider.request({
            method: "eth_requestAccounts",
            params: [],
          })) as string[];
          acct = (accounts[0] ?? "") as Hex;
          if (!acct) throw new Error("wallet returned no accounts");
          setAddress(acct);
        }
      } else {
        // Slow path — first-time connect, MetaMask popup is unavoidable.
        const accounts = (await provider.request({
          method: "eth_requestAccounts",
          params: [],
        })) as string[];
        acct = (accounts[0] ?? "") as Hex;
        if (!acct) throw new Error("wallet returned no accounts");
        setAddress(acct);
      }

      // Chain check / switch — ensureBragaChain returns immediately if already
      // on Braga (fast path). Only triggers a popup when actually switching.
      setStatus("switching-chain");
      await ensureBragaChain(provider);
      const chain = (await provider.request({
        method: "eth_chainId",
        params: [],
      })) as string;
      setChainHex(chain);

      // PARALLELIZE — capability probe and SIWE init are independent. Fire
      // both at once, saves ~200-400ms over sequential.
      setStatus("signing");
      const [capsView, initRes] = await Promise.all([
        probeCapabilities(provider, acct),
        fetch("/api/auth/siwe/init", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            address: acct,
            domain: window.location.host,
            uri: window.location.origin,
          }),
        }),
      ]);
      setCaps(capsView);
      if (!initRes.ok) throw new Error(`siwe init failed: ${initRes.status}`);
      const { message, nonce } = (await initRes.json()) as {
        message: string;
        nonce: string;
      };

      // SIWE signature — unavoidable popup. The previous awaits were the
      // ones we could optimize; this one is the user's actual review moment.
      const signature = (await provider.request({
        method: "personal_sign",
        params: [message, acct],
      })) as string;

      const verifyRes = await fetch("/api/auth/siwe/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          nonce,
          signature,
          signer: acct,
          message,
          capabilities: capsView,
        }),
      });
      if (!verifyRes.ok) {
        const txt = await verifyRes.text();
        throw new Error(`siwe verify failed: ${txt}`);
      }

      setStatus("connected");
      onConnected?.(acct, capsView);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  };

  const switchChain = async () => {
    setError(null);
    const provider = providerRef.current ?? window.ethereum;
    if (!provider) return;
    try {
      await ensureBragaChain(provider);
      const chain = (await provider.request({
        method: "eth_chainId",
        params: [],
      })) as string;
      setChainHex(chain);
      if (chain?.toLowerCase() === BRAGA_CHAIN.hexId.toLowerCase()) {
        setStatus("idle");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // ---- Render states -------------------------------------------------------

  if (status === "wrong-chain") {
    return (
      <div className="right">
        <span className="tag warn">
          {error ?? "Wrong chain — switch to Braga"}
        </span>
        <button type="button" className="primary" onClick={switchChain}>
          Switch to Braga
        </button>
      </div>
    );
  }

  if (status === "connected" && address) {
    return (
      <div className="right">
        {caps?.atomicBatch ? <span className="tag good">Atomic Batch</span> : null}
        {caps?.paymasterService ? (
          <span className="tag good">Paymaster</span>
        ) : null}
        {caps?.sessionKeys ? <span className="tag good">Session Keys</span> : null}
        {chainHex ? (
          <span className="tag muted">chain {parseInt(chainHex, 16)}</span>
        ) : null}
        {providerName ? (
          <span className="tag muted" title="EIP-6963 detected wallet">
            {providerName}
          </span>
        ) : null}
        <span className="address">{truncateAddress(address)}</span>
      </div>
    );
  }

  // Label convention: stay aligned with Web3 norms (RainbowKit / ConnectKit /
  // Reown). "Connect Wallet" regardless of internal state — the click might
  // skip eth_requestAccounts (fast-path), but the user shouldn't see that
  // implementation detail. Signing collapses into "Connecting…" so we don't
  // borrow Google/Apple-style "Sign in" vocabulary.
  const labelByStatus: Record<Exclude<Status, "connected" | "wrong-chain">, string> = {
    idle: "Connect Wallet",
    connecting: "Connecting…",
    "switching-chain": "Switching to Braga…",
    signing: "Connecting…",
    error: "Connect Wallet",
  };

  return (
    <div className="right">
      {error ? <span className="tag warn">{error}</span> : null}
      <button
        type="button"
        className="primary"
        onClick={connect}
        disabled={
          status === "connecting" ||
          status === "switching-chain" ||
          status === "signing"
        }
      >
        {labelByStatus[status as keyof typeof labelByStatus]}
      </button>
    </div>
  );
}
