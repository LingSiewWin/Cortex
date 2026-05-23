/**
 * Cortex — SEDM-fusion utility math (Phase A, hot loop).
 *
 * Pure functions implementing the winning fusion design
 * (docs/research/2026-05-23-sedm-fusion-design.md): a free proxy utility Û(m)
 * per citation, SEDM's weight evolution, lease scaling, and recall fusion.
 * Replaces Cortex's crude flat "+24h per citation" with a continuous,
 * utility-weighted lease + utility-ranked recall.
 *
 * No I/O, no model calls — all arithmetic on signals the hot loop already has,
 * so it adds ~0 cost and is exhaustively unit-testable.
 */

import { UTILITY } from "../constants.ts";

function clamp(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return lo;
  return x < lo ? lo : x > hi ? hi : x;
}

export interface ProxySignals {
  /** ms since this memory was last cited (Infinity / undefined ⇒ first cite). */
  msSinceLastCite: number;
  /** Number of memories cited in THIS decision (≥1). Anti-spam: more cites → less credit each. */
  citationCount: number;
  /** Rank of this memory in the last recall (0 = top). Undefined ⇒ no rank evidence (g=0). */
  rank?: number;
  /** k used in the last recall (top-k). */
  k: number;
  /** Outcome signal in [0,1]; default UTILITY.defaultOutcome when unknown. */
  outcome?: number;
}

/**
 * Proxy utility Û(m) ∈ [0,1] from free signals (SEDM-fusion Layer 1).
 *   r = exp(-Δt/τ)         recency
 *   c = 1/|citations|      co-citation precision
 *   g = 1 - rank/k         recall-rank quality
 *   o = outcome            (default 0.5)
 *   Û = wr·r + wc·c + wg·g + wo·o
 */
export function proxyUtility(s: ProxySignals): number {
  const dt = Number.isFinite(s.msSinceLastCite) ? Math.max(0, s.msSinceLastCite) : Infinity;
  // First-ever cite (dt = Infinity) → r = 0 (no prior recency evidence yet).
  const r = Number.isFinite(dt) ? Math.exp(-dt / UTILITY.recencyTauMs) : 0;
  const c = s.citationCount > 0 ? 1 / s.citationCount : 0;
  const k = s.k > 0 ? s.k : 1;
  // No rank evidence (citation not from a tracked recall) ⇒ no rank bonus.
  const g = s.rank === undefined ? 0 : clamp(1 - s.rank / k, 0, 1);
  const o = clamp(s.outcome ?? UTILITY.defaultOutcome, 0, 1);
  const u =
    UTILITY.sigRecency * r +
    UTILITY.sigCoCite * c +
    UTILITY.sigRank * g +
    UTILITY.sigOutcome * o;
  return clamp(u, 0, 1);
}

/**
 * SEDM weight evolution: w_{t+1} = clamp(w_t + α·Û − β·f_use, 0, wMax).
 * `fUse` is the number of uses since the last weight update (≥1 in the hot loop).
 * The −β·f_use term is the metabolic cost: frequency alone *lowers* weight
 * unless backed by utility, so w ≠ citation count.
 */
export function evolveWeight(wPrev: number, uHat: number, fUse: number): number {
  const w0 = Number.isFinite(wPrev) ? wPrev : UTILITY.wInit;
  const next = w0 + UTILITY.alpha * clamp(uHat, 0, 1) - UTILITY.beta * Math.max(0, fUse);
  return clamp(next, 0, UTILITY.wMax);
}

/**
 * Lease seconds for a citation, scaled by how far the memory's (PRIOR,
 * established) weight exceeds the neutral baseline wInit:
 *   reinforcementSeconds = round(base · (1 + γ·clamp(w − wInit, 0, wMax)))
 *
 * At w = wInit (an unproven / first-cited memory) the factor is exactly 1, so
 * the lease equals `base` — only memories that have *earned* above-baseline
 * weight get longer leases. Monotone in w, always ≥ base (Arkiv extend is
 * strictly increasing — lease never shrinks), bounded by base·(1+γ·wMax).
 */
export function leaseSeconds(baseSeconds: number, w: number): number {
  const excess = clamp((Number.isFinite(w) ? w : UTILITY.wInit) - UTILITY.wInit, 0, UTILITY.wMax);
  const factor = 1 + UTILITY.gamma * excess;
  return Math.round(baseSeconds * factor);
}

/**
 * Recall multiplier: clamp(w, wMin, wMax). The wMin floor keeps cold-start
 * (un-scored, w=wInit) and lightly-penalised memories visible in retrieval.
 */
export function recallWeightFactor(w: number): number {
  const w0 = Number.isFinite(w) ? w : UTILITY.wInit;
  return clamp(w0, UTILITY.wMin, UTILITY.wMax);
}
