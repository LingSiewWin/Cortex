/**
 * Cortex — shared spend guard (Phase 16 hardening).
 *
 * The autonomous loop gates its own spend, but the manual /api/citation/manual
 * endpoint is unauthenticated and was calling act() directly — an unbounded
 * testnet-gas drain if a judge (or anyone) hammers it. This module is the
 * single source of truth for "how much have we spent this session" and
 * enforces a hard cap + a manual rate-limit, consulted by BOTH the loop and
 * the manual endpoint.
 *
 * Process-scoped (resets on restart). Not a substitute for the on-chain
 * SessionAuthorization budget — it's a coarse runaway-spend backstop.
 */

const DEFAULT_SESSION_CAP_WEI = 20_000_000_000_000_000n; // 0.02 GLM total
const MANUAL_MIN_INTERVAL_MS = 2500;

let sessionSpentWei = 0n;
/** Per-IP last-manual-cite timestamp so one attacker can't lock out everyone. */
const lastManualByIp = new Map<string, number>();
const MAX_TRACKED_IPS = 1024;
let capWei = DEFAULT_SESSION_CAP_WEI;

export interface SpendDecision {
  ok: boolean;
  /** HTTP status to return when !ok (429 rate-limited, 402 cap reached). */
  status?: number;
  reason?: string;
}

/** Override the session cap (e.g. from config). */
export function configureSpendCap(wei: bigint): void {
  capWei = wei;
}

/** Record gas actually spent (loop tick OR manual cite) against the session. */
export function recordSpend(wei: bigint): void {
  if (wei > 0n) sessionSpentWei += wei;
}

export function sessionSpentTotalWei(): bigint {
  return sessionSpentWei;
}

export function remainingSessionWei(): bigint {
  const r = capWei - sessionSpentWei;
  return r < 0n ? 0n : r;
}

/**
 * Check whether a MANUAL cite is allowed right now. Enforces a per-IP min
 * interval (anti-hammer that doesn't lock out other clients) and the global
 * session cap. Does NOT record anything — call `markManualCite(ip)` after a
 * successful spend.
 */
export function checkManualAllowed(estCostWei: bigint, ip = "global"): SpendDecision {
  const now = Date.now();
  const last = lastManualByIp.get(ip) ?? 0;
  if (last > 0 && now - last < MANUAL_MIN_INTERVAL_MS) {
    return {
      ok: false,
      status: 429,
      reason: "rate limited — wait a moment between manual cites",
    };
  }
  if (sessionSpentWei + estCostWei > capWei) {
    return {
      ok: false,
      status: 402,
      reason: "session spend cap reached — restart to reset the walkthrough budget",
    };
  }
  return { ok: true };
}

/** Stamp the time of a manual cite for this IP (the rate-limit window). */
export function markManualCite(ip = "global"): void {
  // Bounded map: drop oldest entries if we're tracking too many IPs.
  if (lastManualByIp.size >= MAX_TRACKED_IPS) {
    const oldest = lastManualByIp.keys().next().value;
    if (oldest !== undefined) lastManualByIp.delete(oldest);
  }
  lastManualByIp.set(ip, Date.now());
}

/** Test seam — reset all guard state. */
export function _resetSpendGuard(): void {
  sessionSpentWei = 0n;
  lastManualByIp.clear();
  capWei = DEFAULT_SESSION_CAP_WEI;
}
