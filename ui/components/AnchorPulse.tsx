/**
 * Cortex — Anchor Pulse (Phase 15).
 *
 * Replaces StateRootTile as the HERO surface on /console.
 *
 * A wide blue-gradient card showing:
 *   - The current MMR root (large mono hex, truncated)
 *   - The leaf count
 *   - The latest Arkiv anchor tx hash (clickable → Braga explorer)
 *   - Trigger reason + relative time ("via act() · 2 min ago")
 *   - A heartbeat dot that pulses on every poll, and flashes when a new root
 *     arrives.
 *
 * Self-contained: polls /api/state/root every 5s. Detects new roots by
 * comparing the previous rootHex; triggers a one-shot flash class that
 * auto-clears after the animation.
 */

import { useEffect, useRef, useState } from "react";

interface StateRootRecentCommit {
  id: number;
  rootHex: string;
  leafCount: number;
  computedAtMs: number;
  triggerReason: string;
  anchoredTxHash: string | null;
  anchoredAtBlock: number | null;
  anchoredEntityKey: string | null;
}

interface StateRootResponse {
  currentRoot: string;
  leafCount: number;
  isEmpty: boolean;
  recentCommits: StateRootRecentCommit[];
}

const POLL_MS = 5_000;
const EXPLORER = "https://explorer.braga.hoodi.arkiv.network";

function truncHex(s: string | null, len = 8): string {
  if (!s) return "—";
  if (s.length <= len * 2 + 2) return s;
  return `${s.slice(0, len + 2)}…${s.slice(-len)}`;
}

function relTime(ms: number | null): string {
  if (!ms) return "—";
  const dt = Date.now() - ms;
  if (dt < 0) return "just now";
  if (dt < 60_000) return `${Math.floor(dt / 1000)}s ago`;
  if (dt < 3_600_000) return `${Math.floor(dt / 60_000)} min ago`;
  if (dt < 86_400_000) return `${Math.floor(dt / 3_600_000)}h ago`;
  return `${Math.floor(dt / 86_400_000)}d ago`;
}

export function AnchorPulse() {
  const [data, setData] = useState<StateRootResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const prevRoot = useRef<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch("/api/state/root");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const next = (await res.json()) as StateRootResponse;
        if (!alive) return;
        if (
          prevRoot.current !== null &&
          next.currentRoot !== prevRoot.current &&
          !next.isEmpty
        ) {
          setFlash(true);
          if (flashTimer.current) clearTimeout(flashTimer.current);
          flashTimer.current = setTimeout(() => setFlash(false), 1100);
        }
        prevRoot.current = next.currentRoot;
        setData(next);
        setErr(null);
      } catch (e) {
        if (!alive) return;
        setErr(e instanceof Error ? e.message : String(e));
      }
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
      if (flashTimer.current) clearTimeout(flashTimer.current);
    };
  }, []);

  const latestAnchor = data?.recentCommits.find((c) => c.anchoredTxHash) ?? null;

  return (
    <div className="section">
      <div className="anchor-pulse">
        <div className="anchor-pulse-left">
          <div className="anchor-pulse-header">
            <span
              className="anchor-pulse-heartbeat"
              aria-hidden
              title="MMR live"
            />
            <span className="anchor-pulse-label">Verified history</span>
            <span className="anchor-pulse-sublabel mono">MMR ⇄ Arkiv</span>
          </div>
          {err ? (
            <div className="anchor-pulse-empty">Error: {err}</div>
          ) : !data ? (
            <div className="anchor-pulse-empty">Loading…</div>
          ) : data.isEmpty ? (
            <div className="anchor-pulse-empty mono">
              // no memories — <code>bun run demo-flow</code> to seed
            </div>
          ) : (
            <>
              <div
                className={`anchor-pulse-root mono${flash ? " anchor-flash" : ""}`}
                title={data.currentRoot}
              >
                {truncHex(data.currentRoot)}
              </div>
              <div className="anchor-pulse-leaves mono">
                {data.leafCount.toLocaleString()} leaves
              </div>
            </>
          )}
        </div>
        <div className="anchor-pulse-right">
          {latestAnchor ? (
            <>
              <div className="anchor-pulse-meta">
                <span className="anchor-pulse-meta-label">latest anchor</span>
                <a
                  className="anchor-pulse-tx mono"
                  href={`${EXPLORER}/tx/${latestAnchor.anchoredTxHash}`}
                  target="_blank"
                  rel="noreferrer"
                  title={latestAnchor.anchoredTxHash ?? undefined}
                >
                  {truncHex(latestAnchor.anchoredTxHash)}
                </a>
              </div>
              <div className="anchor-pulse-trigger">
                via <span className="mono">{latestAnchor.triggerReason}()</span>{" "}
                · {relTime(latestAnchor.computedAtMs)}
              </div>
            </>
          ) : data && !data.isEmpty ? (
            <div className="anchor-pulse-meta-empty mono">
              // no anchors yet — POST /api/state/anchor
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
