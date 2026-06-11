export const WEB_CONFIG = {
  rpc: {
    braga: process.env.NEXT_PUBLIC_BRAGA_RPC?.trim() || "https://braga.hoodi.arkiv.network/rpc",
  },
  app: {
    name: "Cortex",
    description: "Darwinian memory engine for AI agents on Arkiv",
    url: process.env.NEXT_PUBLIC_APP_URL?.trim() || "http://localhost:3000",
  },
} as const;
