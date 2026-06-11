"use client";

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cookieToInitialState, WagmiProvider, type Config } from "wagmi";
import { wagmiConfig } from "./wagmi";

/**
 * Console providers — plain wagmi + react-query, injected-only (see ./wagmi.ts).
 * No Reown AppKit: the previous build initialized AppKit unconditionally, which
 * booted a WalletConnect cloud modal even with no projectId and broke the
 * no-extension connect path. Connection is handled by ./hooks/use-connect-wallet.
 */
export function WebProviders({
  children,
  cookies,
}: {
  children: ReactNode;
  cookies: string | null;
}) {
  const [queryClient] = useState(() => new QueryClient());
  const initialState = cookieToInitialState(wagmiConfig as Config, cookies);

  return (
    <WagmiProvider config={wagmiConfig} initialState={initialState}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
