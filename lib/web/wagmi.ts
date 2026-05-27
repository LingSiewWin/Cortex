import { cookieStorage, createStorage, http } from "@wagmi/core";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { mainnet, type AppKitNetwork } from "@reown/appkit/networks";
import { braga } from "@arkiv-network/sdk/chains";
import { WEB_CONFIG } from "./config";

/** Arkiv Braga — chain id 60138453102 (pinned in Cortex constants). */
export const bragaChain = braga;

export const projectId = WEB_CONFIG.walletConnect.projectId;

export const networks = [braga, mainnet] as [AppKitNetwork, ...AppKitNetwork[]];

export const wagmiAdapter = new WagmiAdapter({
  storage: createStorage({ storage: cookieStorage }),
  ssr: true,
  projectId,
  networks,
  transports: {
    [braga.id]: http(WEB_CONFIG.rpc.braga),
    [mainnet.id]: http(),
  },
});

export const wagmiConfig = wagmiAdapter.wagmiConfig;
