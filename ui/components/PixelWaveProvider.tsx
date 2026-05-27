"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { runPixelWaveTransition } from "@/ui/lib/pixel-wave";

type PixelWaveContextValue = {
  /** Navigate to console with pixel-wave transition (or instant if reduced motion). */
  goToConsole: () => void;
  /** True while the transition shader is running. */
  isTransitioning: boolean;
};

const PixelWaveContext = createContext<PixelWaveContextValue | null>(null);

export function PixelWaveProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const busyRef = useRef(false);

  const goToConsole = useCallback(() => {
    if (busyRef.current) return;
    busyRef.current = true;
    void runPixelWaveTransition(() => {
      router.push("/console");
    }).finally(() => {
      // Keep overlay through route change; release lock after teardown
      window.setTimeout(() => {
        busyRef.current = false;
      }, 100);
    });
  }, [router]);

  const value = useMemo(
    () => ({
      goToConsole,
      isTransitioning: false,
    }),
    [goToConsole],
  );

  return <PixelWaveContext.Provider value={value}>{children}</PixelWaveContext.Provider>;
}

export function usePixelWave(): PixelWaveContextValue {
  const ctx = useContext(PixelWaveContext);
  if (!ctx) {
    throw new Error("usePixelWave must be used within PixelWaveProvider");
  }
  return ctx;
}

/** Optional hook — returns null outside provider (e.g. console page). */
export function usePixelWaveOptional(): PixelWaveContextValue | null {
  return useContext(PixelWaveContext);
}
