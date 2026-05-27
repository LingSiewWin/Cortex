/**
 * RainbowKit stack for the `cortex auth` connect page only (minimal wagmi config).
 */

import "@rainbow-me/rainbowkit/styles.css";
import type { ReactNode } from "react";
import { RainbowKitProvider, darkTheme } from "@rainbow-me/rainbowkit";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { connectWagmiConfig } from "./wagmi-connect";

const queryClient = new QueryClient();
const theme = darkTheme({ accentColor: "#0055ff", borderRadius: "medium" });

export function CortexConnectProvider({ children }: { children: ReactNode }) {
  return (
    <WagmiProvider config={connectWagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={theme}>{children}</RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
