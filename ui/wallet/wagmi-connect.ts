/**
 * Minimal wagmi config for the `cortex auth` connect page only.
 *
 * Signing the key-derivation message is chain-agnostic — we only need an injected
 * wallet (MetaMask / Rabby). A single well-known chain keeps RainbowKit/wagmi from
 * probing Braga or WalletConnect cloud during setup.
 */

import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import { injectedWallet } from "@rainbow-me/rainbowkit/wallets";
import { createConfig, http } from "wagmi";
import { mainnet } from "viem/chains";

const connectors = connectorsForWallets(
  [{ groupName: "Wallets", wallets: [injectedWallet] }],
  { appName: "Cortex", projectId: "cortex-local" },
);

export const connectWagmiConfig = createConfig({
  connectors,
  chains: [mainnet],
  transports: { [mainnet.id]: http() },
  ssr: false,
});
