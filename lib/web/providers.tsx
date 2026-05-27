"use client";

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createAppKit } from "@reown/appkit/react";
import { cookieToInitialState, WagmiProvider, type Config } from "wagmi";
import { wagmiAdapter, projectId, networks, bragaChain } from "./wagmi";
import { WEB_CONFIG } from "./config";

let appKitInitialized = false;

function initAppKit() {
  if (appKitInitialized) return;
  appKitInitialized = true;

  createAppKit({
    adapters: [wagmiAdapter],
    projectId,
    networks,
    defaultNetwork: bragaChain,
    metadata: {
      name: WEB_CONFIG.app.name,
      description: WEB_CONFIG.app.description,
      url: typeof window !== "undefined" ? window.location.origin : WEB_CONFIG.app.url,
      icons: [],
    },
    features: { analytics: false },
    themeMode: "dark",
    themeVariables: {
      "--w3m-accent": "#ff5a00",
      "--w3m-color-mix": "#1a1008",
      "--w3m-color-mix-strength": 35,
    },
  });
}

export function WebProviders({
  children,
  cookies,
}: {
  children: ReactNode;
  cookies: string | null;
}) {
  initAppKit();
  const [queryClient] = useState(() => new QueryClient());
  const initialState = cookieToInitialState(wagmiAdapter.wagmiConfig as Config, cookies);

  return (
    <WagmiProvider config={wagmiAdapter.wagmiConfig} initialState={initialState}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
