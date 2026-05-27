"use client";

import {
  useEffect,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
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

  useEffect(() => {
    if (!pixelWave) return;
    const onDocClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest("a[href='/console']");
      if (!anchor?.closest(".cx")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      pixelWave.goToConsole();
    };
    document.addEventListener("click", onDocClick, true);
    return () => document.removeEventListener("click", onDocClick, true);
  }, [pixelWave]);

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
