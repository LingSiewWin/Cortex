/**
 * Cortex — Citation Widget (Phase 16). The /console hero.
 *
 * The dashboard performs itself: an autonomous loop in the server process
 * cites memories every ~20s, and this widget renders that cascade live off the
 * SSE spine — query → recall → reinforce → anchor — with real Braga tx links.
 *
 * A judge can also interrupt: type a query and hit Cite to drive one cycle
 * manually (POST /api/citation/manual), or pause/resume the autonomous agent.
 *
 * No data props — everything comes from the spine (useSSE) + two control
 * endpoints (/api/loop/status, /api/loop/control).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSSE } from "../hooks/useSSE";
import { formatGlm } from "../format";

const EXPLORER = "https://explorer.braga.hoodi.arkiv.network";

type Phase = "idle" | "recalling" | "deciding" | "reinforcing" | "anchored";

const PHASE_ORDER: Phase[] = ["recalling", "deciding", "reinforcing", "anchored"];
const PHASE_LABEL: Record<Phase, string> = {
  idle: "Idle",
  recalling: "Recalling",
  deciding: "Deciding",
  reinforcing: "Reinforcing",
  anchored: "Anchored",
};

interface ManualResult {
  cited: boolean;
  txHashes: string[];
  candidateCount: number;
  error?: string;
}

interface CitationWidgetProps {
  /** Compact layout for demo mode — hides phase track, renames labels. */
  variant?: "full" | "compact";
}

export function CitationWidget({ variant = "full" }: CitationWidgetProps) {
  const compact = variant === "compact";
  // Spine events driving the live phase + current query.
  const cycle = useSSE([
    "agent.loop.tick",
    "recall.completed",
    "memory.cited",
    "anchor.committed",
    "allowance.spent",
  ]);

  const [query, setQuery] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ManualResult | null>(null);
  const [paused, setPaused] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  // Re-render each second so "live N s ago" + idle detection stay fresh.
  const [, force] = useState(0);
  const lastSeenRef = useRef(0);

  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // Poll loop status (running/paused/configured).
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch("/api/loop/status");
        const s = (await res.json()) as {
          running: boolean;
          paused: boolean;
          configured: boolean;
        };
        if (!alive) return;
        setPaused(s.paused);
        setConfigured(s.configured);
      } catch {
        /* ignore — surface stays last-known */
      }
    };
    void tick();
    const t = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // Derive the live phase + current query from the most recent cycle events.
  const { phase, currentQuery, lastAnchorTx, lastSpentRemaining } = useMemo(() => {
    let q = "";
    let ph: Phase = "idle";
    let anchorTx: string | null = null;
    let remaining: string | null = null;
    for (const ev of cycle) {
      const e = ev.event;
      if (e.type === "agent.loop.tick") {
        q = e.query;
        ph = "recalling";
      } else if (e.type === "recall.completed") {
        q = e.query;
        ph = "deciding";
      } else if (e.type === "memory.cited") {
        ph = "reinforcing";
      } else if (e.type === "anchor.committed") {
        ph = "anchored";
        anchorTx = e.txHash;
      } else if (e.type === "allowance.spent") {
        remaining = e.remainingWei;
      }
    }
    return {
      phase: ph,
      currentQuery: q,
      lastAnchorTx: anchorTx,
      lastSpentRemaining: remaining,
    };
  }, [cycle]);

  // Track the freshest event timestamp to show a "live" pulse vs idle.
  const latestTs = cycle.length > 0 ? cycle[cycle.length - 1]!.event.ts : 0;
  if (latestTs > lastSeenRef.current) lastSeenRef.current = latestTs;
  const secsSince = latestTs > 0 ? Math.floor((Date.now() - latestTs) / 1000) : Infinity;
  const live = secsSince < 30;

  const submitManual = useCallback(async () => {
    const q = query.trim();
    if (!q || submitting) return;
    setSubmitting(true);
    setResult(null);
    try {
      const res = await fetch("/api/citation/manual", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: q }),
      });
      const body = (await res.json()) as {
        cited?: boolean;
        txHashes?: string[];
        candidateCount?: number;
        error?: string;
      };
      if (!res.ok) {
        setResult({ cited: false, txHashes: [], candidateCount: 0, error: body.error ?? `HTTP ${res.status}` });
      } else {
        setResult({
          cited: Boolean(body.cited),
          txHashes: body.txHashes ?? [],
          candidateCount: body.candidateCount ?? 0,
        });
      }
    } catch (err) {
      setResult({
        cited: false,
        txHashes: [],
        candidateCount: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  }, [query, submitting]);

  const togglePause = useCallback(async () => {
    const action = paused ? "resume" : "pause";
    setPaused(!paused); // optimistic
    try {
      await fetch("/api/loop/control", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
    } catch {
      setPaused(paused); // revert on failure
    }
  }, [paused]);

  return (
    <div className="cw">
      <div className="cw-head">
        <div className="cw-title">
          <span className={`cw-live-dot${live && !paused ? " cw-live" : ""}`} aria-hidden />
          <span>Autonomous agent</span>
          <span className="cw-sub">
            {configured === false
              ? "read-only (no wallet)"
              : paused
                ? "paused"
                : live
                  ? "live"
                  : "waiting"}
          </span>
        </div>
        <button
          type="button"
          className="cw-pause"
          onClick={togglePause}
          disabled={configured === false}
        >
          {paused ? "▶ Resume" : "⏸ Pause"}
        </button>
      </div>

      {!compact ? (
        <>
          <div className="cw-phases" role="status" aria-label={`phase: ${PHASE_LABEL[phase]}`}>
            {PHASE_ORDER.map((p) => {
              const activeIdx = PHASE_ORDER.indexOf(phase);
              const thisIdx = PHASE_ORDER.indexOf(p);
              const state =
                phase === "idle"
                  ? "pending"
                  : thisIdx < activeIdx
                    ? "done"
                    : thisIdx === activeIdx
                      ? "active"
                      : "pending";
              return (
                <div key={p} className={`cw-phase cw-phase-${state}`}>
                  <span className="cw-phase-tick" aria-hidden />
                  <span className="cw-phase-label">{PHASE_LABEL[p]}</span>
                </div>
              );
            })}
          </div>

          <div className="cw-thought">
            <span className="cw-thought-label">thinking about</span>
            <span className="cw-thought-query">
              {currentQuery || "— waiting for next decision —"}
            </span>
          </div>

          {lastAnchorTx ? (
            <div className="cw-anchor mono">
              state anchored ·{" "}
              <a href={`${EXPLORER}/tx/${lastAnchorTx}`} target="_blank" rel="noreferrer">
                {lastAnchorTx.slice(0, 10)}…
              </a>
            </div>
          ) : null}

          {lastSpentRemaining !== null ? (
            <div className="cw-allowance mono">
              allowance remaining ≈ {formatGlm(lastSpentRemaining)}
            </div>
          ) : null}
        </>
      ) : (
        <div className="cw-thought cw-thought-compact">
          <span className="cw-thought-label">Last recall</span>
          <span className="cw-thought-query">
            {currentQuery || "— waiting for agent —"}
          </span>
        </div>
      )}

      {/* Manual override */}
      <div className="cw-manual">
        <input
          className="cw-input"
          type="text"
          placeholder="Interrupt — ask the agent something…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submitManual();
          }}
          disabled={submitting || configured === false}
        />
        <button
          type="button"
          className="cw-cite"
          onClick={() => void submitManual()}
          disabled={submitting || query.trim().length === 0 || configured === false}
        >
          {submitting ? "Citing…" : "Cite"}
        </button>
      </div>

      {result ? (
        <div className={`cw-result${result.error ? " cw-result-err" : ""}`}>
          {result.error ? (
            <span>error: {result.error}</span>
          ) : result.cited ? (
            <span className="mono">
              cited · {result.txHashes.length} tx ·{" "}
              {result.txHashes[0] ? (
                <a href={`${EXPLORER}/tx/${result.txHashes[0]}`} target="_blank" rel="noreferrer">
                  {result.txHashes[0].slice(0, 10)}…
                </a>
              ) : null}
            </span>
          ) : (
            <span>no matching memory to cite ({result.candidateCount} candidates)</span>
          )}
        </div>
      ) : null}
    </div>
  );
}
