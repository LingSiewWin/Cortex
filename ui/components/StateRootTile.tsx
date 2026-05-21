/**
 * Cortex — Verified History tile (Phase 13.5).
 *
 * Compact status card sitting under the Trilemma scoreboard. Surfaces:
 *   - The current MMR root (the in-memory truth)
 *   - The latest anchor: tx hash + Arkiv explorer link
 *   - Total commits seen vs anchored
 *
 * Read-only. Polls /api/state/root every 5s independent of the main dashboard
 * tick so anchor events feel "live" within ~5s of an act() call.
 */

import { useEffect, useState } from "react";

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

function truncHex(s: string | null, len = 10): string {
  if (!s) return "—";
  if (s.length <= len * 2 + 2) return s;
  return `${s.slice(0, len + 2)}…${s.slice(-len)}`;
}

function relTime(ms: number | null): string {
  if (!ms) return "—";
  const dt = Date.now() - ms;
  if (dt < 0) return "just now";
  if (dt < 60_000) return `${Math.floor(dt / 1000)}s ago`;
  if (dt < 3_600_000) return `${Math.floor(dt / 60_000)}m ago`;
  if (dt < 86_400_000) return `${Math.floor(dt / 3_600_000)}h ago`;
  return `${Math.floor(dt / 86_400_000)}d ago`;
}

export function StateRootTile() {
  const [data, setData] = useState<StateRootResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch("/api/state/root");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const next = (await res.json()) as StateRootResponse;
        if (!alive) return;
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
    };
  }, []);

  const latestAnchored = data?.recentCommits.find((c) => c.anchoredTxHash);
  const anchoredCount =
    data?.recentCommits.filter((c) => c.anchoredTxHash).length ?? 0;
  const totalCommits = data?.recentCommits.length ?? 0;

  return (
    <div className="section">
      <div className="section-title">Verified history (MMR ⇄ Arkiv)</div>
      <div className="card stateroot-card">
        {err ? (
          <div className="empty">Error: {err}</div>
        ) : !data ? (
          <div className="empty">Loading…</div>
        ) : data.isEmpty ? (
          <div className="empty">
            No memories yet — MMR is empty. Run <code>bun run demo-flow</code>{" "}
            to seed.
          </div>
        ) : (
          <>
            <div className="stateroot-row">
              <span className="k">🔐 Current root</span>
              <span className="mono">{truncHex(data.currentRoot)}</span>
              <span className="muted">· {data.leafCount} leaves</span>
            </div>
            <div className="stateroot-row">
              <span className="k">📦 Latest anchor</span>
              {latestAnchored ? (
                <>
                  <a
                    className="mono"
                    href={`${EXPLORER}/tx/${latestAnchored.anchoredTxHash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {truncHex(latestAnchored.anchoredTxHash)}
                  </a>
                  <span className="muted">
                    · trigger: {latestAnchored.triggerReason} ·{" "}
                    {relTime(latestAnchored.computedAtMs)}
                  </span>
                </>
              ) : (
                <span className="muted">
                  No anchors yet — commit roots via{" "}
                  <code>POST /api/state/anchor</code> or run{" "}
                  <code>demo-flow</code>.
                </span>
              )}
            </div>
            <div className="stateroot-row">
              <span className="k">🧾 Commits</span>
              <span>
                {totalCommits} total · {anchoredCount} anchored to Arkiv
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
