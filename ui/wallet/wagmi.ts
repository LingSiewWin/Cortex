/**
 * Cortex — shared wagmi + RainbowKit config (one wallet stack, used by BOTH the
 * `cortex auth` connect page (ui/connect) and the console dashboard (ui/console)).
 *
 * INJECTED-ONLY (no WalletConnect): both surfaces run on the same machine as the
 * user's wallet extension, so WalletConnect-QR is pointless — and dropping it keeps
 * the standalone browser bundle free of WalletConnect's Node-only deps. EIP-6963
 * discovery (wagmi's `injected` connector, surfaced by RainbowKit) covers MetaMask,
 * Rabby, Backpack, etc.
 *
 * `mainnet` is imported from `viem/chains` (NOT `wagmi/chains`): RainbowKit's
 * always-mounted AccountModal reads `mainnet.id` for ENS, and only the direct viem
 * import makes Bun fire viem's lazy `init_mainnet()` before our config runs —
 * otherwise the minified bundle leaves `mainnet` undefined and the app crashes on
 * first render. We sign on any chain, so Ethereum here is purely for ENS display.
 */

import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import { injectedWallet } from "@rainbow-me/rainbowkit/wallets";
import { createConfig, http } from "wagmi";
import { mainnet } from "viem/chains";
import { braga } from "@arkiv-network/sdk/chains";
import type { Chain } from "viem";

export const bragaChain = braga as unknown as Chain;

const connectors = connectorsForWallets(
  // injectedWallet ignores projectId; the arg is required by the type only.
  [{ groupName: "Wallets", wallets: [injectedWallet] }],
  { appName: "Cortex", projectId: "cortex-local" },
);

export const wagmiConfig = createConfig({
  connectors,
  chains: [bragaChain, mainnet],
  transports: { [bragaChain.id]: http(), [mainnet.id]: http() },
  ssr: false,
});
