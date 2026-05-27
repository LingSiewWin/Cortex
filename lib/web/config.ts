export const WEB_CONFIG = {
  walletConnect: {
    projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim() || "unset",
  },
  rpc: {
    braga: process.env.NEXT_PUBLIC_BRAGA_RPC?.trim() || "https://braga.hoodi.arkiv.network/rpc",
  },
  app: {
    name: "Cortex",
    description: "Darwinian memory engine for AI agents on Arkiv",
    url: process.env.NEXT_PUBLIC_APP_URL?.trim() || "http://localhost:3000",
  },
} as const;

export function isWalletConnectConfigured(): boolean {
  const id = WEB_CONFIG.walletConnect.projectId;
  return id.length > 0 && id !== "unset";
}
