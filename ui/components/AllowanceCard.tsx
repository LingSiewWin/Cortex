/**
 * Cortex — Agent Allowance dashboard card.
 *
 * Renders the "parent sets a monthly allowance for the AI child" view:
 *
 *   ┌─────────────────────────────────────────────┐
 *   │  Agent Allowance — session 0xab12          │
 *   ├─────────────────────────────────────────────┤
 *   │   Budget:   0.00100 GLM                     │
 *   │   Spent:    0.00037 GLM   ████████░░░       │
 *   │   Remaining: 0.00063 GLM  (37% used)        │
 *   │                                             │
 *   │   Est daily: 0.00500 GLM (5 days runway)    │
 *   │   Refill at: 0.00010 GLM                    │
 *   │                                             │
 *   │   [Refill +0.001 GLM]  [Pause Agent]        │
 *   │                                             │
 *   │   Master: 0x132E…98Bb (you)                 │
 *   │   Last 12 spends: ████ ▆▆ █ ▃▃ ███          │
 *   └─────────────────────────────────────────────┘
 *
 * Polls `/api/allowance?sessionKey=…` every 5s while mounted. Reads the
 * `AllowanceSnapshot` JSON shape exported from `src/api/allowance.ts`.
 */

import { useCallback, useEffect, useState } from "react";
import { formatGlm, truncateAddress } from "../format";
import type { Hex } from "../types";

const REFRESH_MS = 5_000;

interface RecentSpendView {
  atMs: number;
  gasWei: string;
  txHash: Hex | null;
}

interface AllowanceSnapshot {
  sessionKey: Hex;
  master: Hex;
  scope: Hex;
  entityNamespace: Hex;
  maxWrites: number;
  writeCount: number;
  maxGasWei: string;
  spentWei: string;
  remainingWei: string;
  refillThresholdWei: string;
  estimatedDailyCostWei: string;
  runwayDays: number | null;
  validAfter: number;
  validBefore: number;
  state: "active" | "exhausted" | "expired" | "paused";
  createdAtMs: number;
  lastSpendAtMs: number | null;
  refilledFrom: Hex | null;
  recentSpends: RecentSpendView[];
}

interface AllowanceCardProps {
  /** If null/undefined, the card renders an empty-state CTA. */
  sessionKey?: Hex | null;
  /** The currently-connected master (so we can label "(you)"). */
  master?: Hex | null;
}

// ---------------------------------------------------------------------------
// Helpers — pure
// ---------------------------------------------------------------------------

function safeBigInt(s: string): bigint {
  try {
    return BigInt(s);
  } catch {
    return 0n;
  }
}

function percentUsed(spent: bigint, max: bigint): number {
  if (max <= 0n) return 0;
  // Scale to 0..10000 then divide for two-decimal precision without floats.
  const scaled = (spent * 10_000n) / max;
  const pct = Number(scaled) / 100;
  if (!Number.isFinite(pct)) return 0;
  if (pct > 100) return 100;
  if (pct < 0) return 0;
  return pct;
}

function isBelowRefillThreshold(remaining: bigint, threshold: bigint): boolean {
  if (threshold <= 0n) return false;
  return remaining <= threshold;
}

function formatRunway(days: number | null): string {
  if (days === null) return "—";
  if (days >= 9_999) return ">10000d";
  if (days < 1) {
    const hours = days * 24;
    if (hours < 1) {
      const minutes = hours * 60;
      return `${minutes.toFixed(0)}m runway`;
    }
    return `${hours.toFixed(1)}h runway`;
  }
  return `${days.toFixed(1)} days runway`;
}

function spendBars(spends: RecentSpendView[]): Array<{ heightPct: number; atMs: number; gasWei: string }> {
  if (spends.length === 0) return [];
  // Newest first in the data; render left-to-right oldest-first so the most
  // recent bar is on the right (matches a typical sparkline).
  const ordered = [...spends].sort((a, b) => a.atMs - b.atMs);
  let max = 0n;
  for (const s of ordered) {
    const g = safeBigInt(s.gasWei);
    if (g > max) max = g;
  }
  if (max === 0n) {
    return ordered.map((s) => ({
      heightPct: 12,
      atMs: s.atMs,
      gasWei: s.gasWei,
    }));
  }
  return ordered.map((s) => {
    const g = safeBigInt(s.gasWei);
    // Min 8% so even tiny spends render a visible nub.
    const raw = (g * 100n) / max;
    const heightPct = Math.max(8, Math.min(100, Number(raw)));
    return { heightPct, atMs: s.atMs, gasWei: s.gasWei };
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AllowanceCard({ sessionKey, master }: AllowanceCardProps) {
  const [snapshot, setSnapshot] = useState<AllowanceSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!sessionKey) return;
    try {
      const res = await fetch(
        `/api/allowance?sessionKey=${encodeURIComponent(sessionKey)}`,
      );
      if (res.status === 404) {
        setSnapshot(null);
        setError(null);
        setLoaded(true);
        return;
      }
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`allowance ${res.status}: ${txt}`);
      }
      const data = (await res.json()) as AllowanceSnapshot;
      setSnapshot(data);
      setError(null);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoaded(true);
    }
  }, [sessionKey]);

  useEffect(() => {
    if (!sessionKey) {
      setSnapshot(null);
      setError(null);
      setLoaded(true);
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      await load();
      if (!alive) return;
      timer = setTimeout(tick, REFRESH_MS);
    };
    tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [sessionKey, load]);

  // Stub actions for v1. The real refill flow is a fresh SessionAuthorizationV2
  // signature; a future PR will land the SIWE-extended-with-budget signer here.
  const onRefill = useCallback(() => {
    // eslint-disable-next-line no-console
    console.log(
      "[AllowanceCard] Refill flow not wired in v1; sign a new SessionAuthorizationV2 with more budget.",
    );
  }, []);
  const onPause = useCallback(() => {
    // eslint-disable-next-line no-console
    console.warn(
      "[AllowanceCard] Pause flow stub — POST /api/allowance/refill with state='paused' in v2.",
    );
  }, []);

  // ---------------------------------------------------------------------------
  // Empty state — no session key passed in
  // ---------------------------------------------------------------------------
  if (!sessionKey) {
    return (
      <div className="section">
        <div className="section-title">Agent Allowance</div>
        <div className="card allowance-card empty-allowance">
          <div className="empty">
            No active session allowance. Sign a SessionAuthorizationV2 to grant
            an ephemeral agent a GLM budget + write cap.
          </div>
          <div className="budget-actions" style={{ justifyContent: "center" }}>
            <button type="button" disabled title="Wire-up landing in v2">
              Sign a session allowance
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="section">
        <div className="section-title">Agent Allowance</div>
        <div className="card allowance-card">
          <div className="empty">Loading…</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="section">
        <div className="section-title">Agent Allowance</div>
        <div className="card allowance-card" role="alert">
          <strong>Allowance lookup failed.</strong> {error}
        </div>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="section">
        <div className="section-title">Agent Allowance</div>
        <div className="card allowance-card empty-allowance">
          <div className="empty">
            No allowance found for session {truncateAddress(sessionKey)}.
          </div>
        </div>
      </div>
    );
  }

  const spent = safeBigInt(snapshot.spentWei);
  const maxGas = safeBigInt(snapshot.maxGasWei);
  const remaining = safeBigInt(snapshot.remainingWei);
  const refillThreshold = safeBigInt(snapshot.refillThresholdWei);
  const pct = percentUsed(spent, maxGas);
  const lowBalance = isBelowRefillThreshold(remaining, refillThreshold);
  const bars = spendBars(snapshot.recentSpends);
  const stateClass =
    snapshot.state === "active"
      ? "good"
      : snapshot.state === "exhausted"
        ? "bad"
        : snapshot.state === "expired"
          ? "muted"
          : "warn";
  const isYou =
    master && snapshot.master.toLowerCase() === master.toLowerCase();

  return (
    <div className="section">
      <div className="section-title">
        Agent Allowance
        <span className={`tag ${stateClass}`} style={{ marginLeft: 8 }}>
          {snapshot.state}
        </span>
        {lowBalance && snapshot.state === "active" ? (
          <span className="tag warn" style={{ marginLeft: 6 }}>
            refill recommended
          </span>
        ) : null}
      </div>
      <div className="card allowance-card">
        <div className="budget-row" style={{ marginBottom: 12 }}>
          <span className="muted">session</span>
          <span className="mono">{truncateAddress(snapshot.sessionKey)}</span>
        </div>

        <div className="budget-stats">
          <div className="budget-row">
            <span className="muted">Budget</span>
            <span className="value mono">{formatGlm(snapshot.maxGasWei)}</span>
          </div>
          <div className="budget-row">
            <span className="muted">Spent</span>
            <span className="value mono">{formatGlm(snapshot.spentWei)}</span>
          </div>
          <div className="budget-meter" aria-label={`${pct.toFixed(0)}% used`}>
            <span
              className="budget-meter-fill"
              style={{ width: `${pct.toFixed(2)}%` }}
            />
          </div>
          <div className="budget-row">
            <span className="muted">Remaining</span>
            <span className="value mono">
              {formatGlm(snapshot.remainingWei)}{" "}
              <span className="muted" style={{ marginLeft: 8 }}>
                ({pct.toFixed(0)}% used)
              </span>
            </span>
          </div>
        </div>

        <div className="budget-stats" style={{ marginTop: 12 }}>
          <div className="budget-row">
            <span className="muted">Est daily</span>
            <span className="mono">
              {formatGlm(snapshot.estimatedDailyCostWei)}{" "}
              <span className="muted">({formatRunway(snapshot.runwayDays)})</span>
            </span>
          </div>
          <div className="budget-row">
            <span className="muted">Refill at</span>
            <span className="mono">
              {formatGlm(snapshot.refillThresholdWei)}
            </span>
          </div>
          <div className="budget-row">
            <span className="muted">Writes</span>
            <span className="mono">
              {snapshot.writeCount.toLocaleString()} /{" "}
              {snapshot.maxWrites.toLocaleString()}
            </span>
          </div>
        </div>

        <div className="budget-actions">
          <button
            type="button"
            className="primary"
            onClick={onRefill}
            disabled={snapshot.state === "expired"}
          >
            Refill +{formatGlm(snapshot.maxGasWei)}
          </button>
          <button
            type="button"
            onClick={onPause}
            disabled={snapshot.state !== "active"}
          >
            Pause Agent
          </button>
        </div>

        <div className="budget-row" style={{ marginTop: 14 }}>
          <span className="muted">Master</span>
          <span className="mono">
            {truncateAddress(snapshot.master)}
            {isYou ? <span className="muted"> (you)</span> : null}
          </span>
        </div>

        <div className="budget-row" style={{ alignItems: "flex-end" }}>
          <span className="muted">Last 12 spends</span>
          <div className="spend-bars">
            {bars.length === 0 ? (
              <span className="muted">no spends yet</span>
            ) : (
              bars.map((b, i) => (
                <span
                  key={`${b.atMs}-${i}`}
                  className="spend-bar"
                  style={{ height: `${b.heightPct}%` }}
                  title={`${formatGlm(b.gasWei)} at ${new Date(b.atMs).toLocaleTimeString()}`}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
