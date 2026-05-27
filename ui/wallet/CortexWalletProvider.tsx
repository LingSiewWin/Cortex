/**
 * Cortex — the shared RainbowKit provider stack. Wrap any app that needs the
 * wallet UI (the `cortex auth` page and the console) in this so they share one
 * config, one theme, one QueryClient.
 */

import "@rainbow-me/rainbowkit/styles.css";
import type { ReactNode } from "react";
import { RainbowKitProvider, darkTheme } from "@rainbow-me/rainbowkit";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { wagmiConfig } from "./wagmi";

const queryClient = new QueryClient();
const theme = darkTheme({ accentColor: "#0055ff", borderRadius: "medium" });

export function CortexWalletProvider({ children }: { children: ReactNode }) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={theme}>{children}</RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
