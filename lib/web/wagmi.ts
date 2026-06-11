import { cookieStorage, createStorage, http } from "@wagmi/core";
import { createConfig } from "wagmi";
import { injected } from "wagmi/connectors";
import { mainnet } from "viem/chains";
import { braga } from "@arkiv-network/sdk/chains";
import type { Chain } from "viem";
import { WEB_CONFIG } from "./config";

/**
 * Console wallet config — INJECTED ONLY (MetaMask / Rabby / any EIP-6963 wallet).
 *
 * The console's job is an on-camera proof that the USER's own wallet signs and
 * pays Braga gas per write. That only needs a desktop browser-extension wallet,
 * so we deliberately drop the WalletConnect/Reown cloud stack: it added a hosted
 * dependency (a `projectId` that, when unset, booted an AppKit modal that broke
 * the no-extension path) for a mobile-QR flow this surface doesn't need. The
 * sovereign, local-first product is the plugin — not this console.
 */

/** Arkiv Braga — chain id 60138453102 (pinned in Cortex constants). */
export const bragaChain = braga as unknown as Chain;

export const wagmiConfig = createConfig({
  chains: [bragaChain, mainnet],
  connectors: [injected({ shimDisconnect: true })],
  storage: createStorage({ storage: cookieStorage }),
  ssr: true,
  transports: {
    [bragaChain.id]: http(WEB_CONFIG.rpc.braga),
    [mainnet.id]: http(),
  },
});
