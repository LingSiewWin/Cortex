/**
 * Cortex — chain-health detector (the Sync plane of the resilience protocol).
 *
 * Braga is non-stationary: it cycles through three observable states, and a fixed
 * authority model is wrong in two of them (see the 3-way design debate +
 * docs/arkiv-network/). This module classifies the live chain so the anchor worker
 * can ADAPT its operations — without ever moving the truth authority (cognition is
 * always local; the verifiable claim is always chain-anchored). Correctness lives
 * in idempotency, NOT in this detector: a misclassification only costs efficiency
 * (a delayed drain or a redundant read), never data integrity.
 *
 *   HEALTHY  — head advancing, RPC pool tight (spread ≤ threshold): drain aggressively.
 *   DEGRADED — head advancing but RPC pool inconsistent (reads from nodes at
 *              different heights → read-after-write fails nondeterministically):
 *              slow down, read-your-writes, drain one-at-a-time.
 *   STALLED  — head frozen: stop draining (don't burn gas/nonces against a dead
 *              head); the agent keeps running fully on the local mirror.
 *
 * Hysteresis + a minimum dwell time prevent flapping. The fail-safe default is
 * STALLED — the safe degenerate (no on-chain writes), so a broken/uninitialised
 * detector behaves like pure local-authoritative, never like "burn gas blindly".
 */

import { BRAGA } from "../constants.ts";

export type ChainMode = "healthy" | "degraded" | "stalled";

/** Tight RPC-pool spread (blocks) below which reads are considered consistent. */
const DEFAULT_SPREAD_THRESHOLD = 50;
/** Consecutive confirming observations required to change mode (anti-flap). */
const DEFAULT_CONFIRM = 2;
/** Minimum time to stay in a mode before any transition (anti-flap, ms). */
const DEFAULT_DWELL_MS = 30_000;

export interface ChainObservation {
  /** Did the head advance vs the previous observation? */
  headAdvanced: boolean;
  /** max−min of rapid eth_blockNumber samples this observation. */
  spread: number;
}

/**
 * Pure, stateless classification of a single observation → candidate mode.
 * No hysteresis here — that's the detector's job.
 */
export function classifyObservation(
  o: ChainObservation,
  spreadThreshold = DEFAULT_SPREAD_THRESHOLD,
): ChainMode {
  if (!o.headAdvanced) return "stalled";
  if (o.spread > spreadThreshold) return "degraded";
  return "healthy";
}

export interface DetectorOptions {
  spreadThreshold?: number;
  confirm?: number;
  dwellMs?: number;
  /** Injected clock (tests). Default Date.now. */
  now?: () => number;
}

/**
 * Stateful health detector. Feed it observations (head + spread) via `observe`;
 * it applies hysteresis + dwell and returns the current authoritative mode.
 */
export class ChainHealthDetector {
  private _mode: ChainMode = "stalled"; // fail-safe default
  private lastHead: number | null = null;
  private pendingCandidate: ChainMode | null = null;
  private pendingCount = 0;
  private lastTransitionAt = 0;
  private readonly spreadThreshold: number;
  private readonly confirm: number;
  private readonly dwellMs: number;
  private readonly now: () => number;

  constructor(opts?: DetectorOptions) {
    this.spreadThreshold = opts?.spreadThreshold ?? DEFAULT_SPREAD_THRESHOLD;
    this.confirm = opts?.confirm ?? DEFAULT_CONFIRM;
    this.dwellMs = opts?.dwellMs ?? DEFAULT_DWELL_MS;
    this.now = opts?.now ?? Date.now;
  }

  get mode(): ChainMode {
    return this._mode;
  }

  /**
   * Record a fresh head + spread sample; returns the (possibly unchanged) mode.
   * `head` is the current chain head; `spread` is the max−min of rapid samples.
   */
  observe(sample: { head: number; spread: number }): ChainMode {
    const headAdvanced = this.lastHead !== null && sample.head > this.lastHead;
    // First observation has no prior head → treat as "not advanced" (stays in the
    // safe STALLED default until a real advance is seen).
    this.lastHead = sample.head;

    const candidate = classifyObservation(
      { headAdvanced, spread: sample.spread },
      this.spreadThreshold,
    );

    if (candidate === this._mode) {
      this.pendingCandidate = null;
      this.pendingCount = 0;
      return this._mode;
    }

    // Candidate differs from current mode — accumulate confirmations.
    if (candidate === this.pendingCandidate) {
      this.pendingCount += 1;
    } else {
      this.pendingCandidate = candidate;
      this.pendingCount = 1;
    }

    const dwellOk = this.now() - this.lastTransitionAt >= this.dwellMs;
    if (this.pendingCount >= this.confirm && dwellOk) {
      this._mode = candidate;
      this.lastTransitionAt = this.now();
      this.pendingCandidate = null;
      this.pendingCount = 0;
    }
    return this._mode;
  }

  /** Test/boot seam — force a mode (e.g. seed HEALTHY in a test). */
  _setModeForTest(mode: ChainMode): void {
    this._mode = mode;
    this.lastTransitionAt = 0;
    this.pendingCandidate = null;
    this.pendingCount = 0;
  }
}

export interface SampleDeps {
  /** Returns the current chain head (block number). Default: eth_blockNumber on Braga. */
  getHead?: () => Promise<number>;
  /** Samples to take per observation (spread = max−min). Default 5. */
  samples?: number;
  /** Delay between samples (ms). Default 250. */
  gapMs?: number;
}

async function defaultGetHead(): Promise<number> {
  const r = await fetch(BRAGA.httpRpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
  });
  const j = (await r.json()) as { result?: string };
  if (!j.result) throw new Error("eth_blockNumber returned no result");
  return parseInt(j.result, 16);
}

/**
 * Take a burst of head samples and return the max head + the spread (max−min).
 * A large spread means the RPC load-balancer is serving inconsistent nodes
 * (the DEGRADED signal). Throws if every sample failed.
 */
export async function sampleChainHead(
  deps?: SampleDeps,
): Promise<{ head: number; spread: number }> {
  const getHead = deps?.getHead ?? defaultGetHead;
  const n = deps?.samples ?? 5;
  const gapMs = deps?.gapMs ?? 250;
  const heads: number[] = [];
  for (let i = 0; i < n; i++) {
    try {
      heads.push(await getHead());
    } catch {
      /* skip a failed sample */
    }
    if (i < n - 1 && gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
  }
  if (heads.length === 0) throw new Error("sampleChainHead: all samples failed");
  return { head: Math.max(...heads), spread: Math.max(...heads) - Math.min(...heads) };
}
