"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { usePixelWaveOptional } from "./PixelWaveProvider";

type ConsoleLinkProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> & {
  children: ReactNode;
};

/**
 * Navigates to /console with pixel-wave transition.
 * Uses <button> (not <a>) so the first click cannot beat React hydration.
 */
export function ConsoleLink({ children, onClick, className, ...rest }: ConsoleLinkProps) {
  const pixelWave = usePixelWaveOptional();

  return (
    <button
      type="button"
      className={["cx-console-link", className].filter(Boolean).join(" ")}
      {...rest}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented) return;
        if (pixelWave) pixelWave.goToConsole();
        else window.location.assign("/console");
      }}
    >
      {children}
    </button>
  );
}
