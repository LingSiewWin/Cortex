/**
 * Cortex — Anchor Pill (Phase 16).
 *
 * Compact topbar replacement for the AnchorPulse hero card. Subscribes to
 * `anchor.committed` on the live spine and shows the current MMR root prefix +
 * age, flashing when a fresh root lands. Clicking opens the anchor tx on the
 * Braga explorer.
 *
 * The widget is now the hero; the cryptographic-anchor story compresses into
 * this always-visible pill so it stays present without competing for space.
 */

import { useEffect, useRef, useState } from "react";
import { useLatestEvent } from "../hooks/useSSE";

const EXPLORER = "https://explorer.braga.hoodi.arkiv.network";

function truncHex(s: string, len = 6): string {
  if (s.length <= len * 2 + 2) return s;
  return `${s.slice(0, len + 2)}…${s.slice(-4)}`;
}

function relTime(ms: number): string {
  const dt = Date.now() - ms;
  if (dt < 0 || dt < 2000) return "just now";
  if (dt < 60_000) return `${Math.floor(dt / 1000)}s ago`;
  if (dt < 3_600_000) return `${Math.floor(dt / 60_000)}m ago`;
  return `${Math.floor(dt / 3_600_000)}h ago`;
}

export function AnchorPill() {
  const latest = useLatestEvent("anchor.committed");
  const [flash, setFlash] = useState(false);
  const prevRoot = useRef<string | null>(null);
  // Re-render every second so the relative time stays fresh.
  const [, force] = useState(0);

  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!latest) return;
    if (latest.rootHex !== prevRoot.current) {
      if (prevRoot.current !== null) {
        setFlash(true);
        const t = setTimeout(() => setFlash(false), 1100);
        prevRoot.current = latest.rootHex;
        return () => clearTimeout(t);
      }
      prevRoot.current = latest.rootHex;
    }
    return undefined;
  }, [latest]);

  if (!latest) {
    return (
      <span className="anchor-pill anchor-pill-idle" title="No state root anchored yet">
        <span className="anchor-pill-dot" aria-hidden />
        <span className="anchor-pill-root mono">root —</span>
      </span>
    );
  }

  return (
    <a
      className={`anchor-pill${flash ? " anchor-pill-flash" : ""}`}
      href={`${EXPLORER}/tx/${latest.txHash}`}
      target="_blank"
      rel="noreferrer"
      title={`MMR root ${latest.rootHex} · ${latest.leafCount} leaves · anchored on Arkiv`}
    >
      <span className="anchor-pill-dot" aria-hidden />
      <span className="anchor-pill-root mono">{truncHex(latest.rootHex)}</span>
      <span className="anchor-pill-age">{relTime(latest.ts)}</span>
    </a>
  );
}
