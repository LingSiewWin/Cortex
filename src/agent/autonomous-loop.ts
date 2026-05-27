/**
 * Cortex — Autonomous citation loop (Phase 16).
 *
 * The dashboard's always-on heartbeat. Every `cadenceMs` it:
 *   1. picks a query from the pool (no immediate repeat)
 *   2. emits `agent.loop.tick`
 *   3. recall(query, k) → candidate memories       → `rabitq.encoded` (via embeddings)
 *   4. emits `recall.completed`
 *   5. act(action, citations=[top N])              → `memory.cited`, `mmr.appended`,
 *                                                     `anchor.committed`, `arkiv.rpc.call`
 *   6. emits `allowance.spent` (estimated tick cost)
 *   7. reschedules
 *
 * A judge landing on /console sees this cascade fire within seconds — no CLI,
 * no typing. The same code path backs the manual "Cite" override (api/citation.ts)
 * and `bun run demo-flow`, so every surface animates identically.
 *
 * Allowance gate: when the remaining allowance drops below
 * `allowanceFloorWei + estimatedTickCostWei`, the loop auto-pauses (so a live
 * demo can't drain the session-key wallet mid-pitch). Resumable manually.
 *
 * Testability: every side-effecting dependency (recall, act, timer, RNG,
 * allowance reader, clock) is injectable. Tests drive deterministic ticks via
 * `interrupt()` and assert scheduling via the injected timer.
 */

import type { Hex } from "@arkiv-network/sdk";
import type { MemoryHit } from "../darwinian/recall.ts";
import type { ActResult, ActOptions } from "../darwinian/citation.ts";
import { publish } from "../lib/events.ts";
import { runCiteCycle } from "./citation-cycle.ts";
import { recordSpend, remainingSessionWei } from "./spend-guard.ts";
import { distillIfReady } from "../darwinian/distill.ts";

export type TimerHandle = ReturnType<typeof setTimeout> | number;

export interface AutonomousLoopDeps {
  recall?: (opts: {
    query: string;
    k?: number;
  }) => Promise<MemoryHit[]>;
  act?: (opts: ActOptions) => Promise<ActResult>;
  /**
   * Returns remaining allowance in wei, or null to disable the gate.
   * Production reads the SQLite allowance row; tests inject a value.
   */
  readAllowanceWei?: () => Promise<bigint | null>;
  setTimer?: (cb: () => void, ms: number) => TimerHandle;
  clearTimer?: (h: TimerHandle) => void;
  random?: () => number;
  now?: () => number;
  /** Override the semantic distillation step (tests). */
  distill?: (userPrimaryEOA: Hex) => Promise<void>;
}

export interface AutonomousLoopOptions {
  /** Curated natural-language queries the agent rotates through. */
  queryPool: string[];
  /** User EOA that owns promoted memories (act requires it). */
  userPrimaryEOA: Hex;
  /** Milliseconds between ticks. Default 15_000. */
  cadenceMs?: number;
  /** Delay before the FIRST tick (lets the page mount). Default 2_000. */
  initialDelayMs?: number;
  /** Top-k passed to recall. Default 5. */
  k?: number;
  /** How many of the recall hits to cite in act(). Default 1. */
  citeTopN?: number;
  /** Run semantic distillation every N successful ticks. Default 6. */
  distillEveryNTicks?: number;
  /** Pause when remaining allowance < floor + tick cost. Default 0n. */
  allowanceFloorWei?: bigint;
  /** Estimated gas cost per tick (drives allowance.spent + the gate). Default 4e13 (~0.00004 ETH). */
  estimatedTickCostWei?: bigint;
  /**
   * Soft session budget for the demo. When no `readAllowanceWei` dep is wired,
   * the loop tracks spend internally against this budget so allowance.spent
   * reports a real decrementing remaining. Default 0.01 GLM.
   */
  sessionBudgetWei?: bigint;
  _deps?: AutonomousLoopDeps;
}

export interface AutonomousLoopHandle {
  /** Stop scheduling new ticks (in-flight tick still completes). */
  pause(): void;
  /** Resume scheduling. No-op if already running or stopped. */
  resume(): void;
  /** Cancel the pending timer, run ONE tick now with `query`, then reschedule. */
  interrupt(query: string): Promise<void>;
  isPaused(): boolean;
  isStopped(): boolean;
  /** Permanent teardown — clears the timer; the handle becomes inert. */
  stop(): void;
}

const DEFAULT_CADENCE_MS = 15_000;
const DEFAULT_INITIAL_DELAY_MS = 2_000;
const DEFAULT_TICK_COST_WEI = 40_000_000_000_000n; // ~0.00004 ETH
const DEFAULT_SESSION_BUDGET_WEI = 10_000_000_000_000_000n; // 0.01 GLM soft demo budget

/**
 * Start the autonomous loop. Returns a handle for pause/resume/interrupt/stop.
 * The first tick is scheduled after `initialDelayMs`.
 */
export function startAutonomousLoop(
  opts: AutonomousLoopOptions,
): AutonomousLoopHandle {
  if (!Array.isArray(opts.queryPool) || opts.queryPool.length === 0) {
    throw new Error("startAutonomousLoop: queryPool must be a non-empty array");
  }

  const cadenceMs = opts.cadenceMs ?? DEFAULT_CADENCE_MS;
  const initialDelayMs = opts.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const k = opts.k ?? 5;
  const citeTopN = opts.citeTopN ?? 1;
  const floor = opts.allowanceFloorWei ?? 0n;
  const tickCost = opts.estimatedTickCostWei ?? DEFAULT_TICK_COST_WEI;
  const sessionBudget = opts.sessionBudgetWei ?? DEFAULT_SESSION_BUDGET_WEI;
  const cadenceSeconds = Math.max(1, Math.round(cadenceMs / 1000));
  const distillEveryNTicks = opts.distillEveryNTicks ?? 6;
  const distill =
    opts._deps?.distill ??
    (async (userPrimaryEOA: Hex) => {
      // No-op SQLite check unless a memory crossed the semantic threshold
      // (cited ≥5× across ≥3 sessions). Only then does it call the LLM + write
      // a RULE entity. Single-session demos won't trigger it — see
      // scripts/distill-demo.ts to prove the RULE tier end-to-end.
      await distillIfReady({ userPrimaryEOA });
    });
  let spentWei = 0n;
  let completedTicks = 0;

  // recall/act are routed through the shared cite cycle (deps passed below),
  // so the loop and the manual endpoint animate the dashboard identically.
  const cycleDeps = {
    ...(opts._deps?.recall ? { recall: opts._deps.recall } : {}),
    ...(opts._deps?.act ? { act: opts._deps.act } : {}),
  };
  const readAllowanceWei = opts._deps?.readAllowanceWei ?? null;
  const setTimer = opts._deps?.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer =
    opts._deps?.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const random = opts._deps?.random ?? Math.random;
  const now = opts._deps?.now ?? Date.now;

  let paused = false;
  let stopped = false;
  let timer: TimerHandle | null = null;
  let lastQueryIndex = -1;
  let inFlight = false;

  function pickQuery(): string {
    const pool = opts.queryPool;
    if (pool.length === 1) return pool[0]!;
    let idx = Math.floor(random() * pool.length);
    if (idx === lastQueryIndex) idx = (idx + 1) % pool.length;
    lastQueryIndex = idx;
    return pool[idx]!;
  }

  function schedule(ms: number): void {
    if (stopped || paused) return;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => {
      void tickAndReschedule();
    }, ms);
  }

  async function tickAndReschedule(): Promise<void> {
    await runTick(pickQuery());
    schedule(cadenceMs);
  }

  /**
   * One full cycle. Swallows recall/act errors (e.g. Cohere 429) so a single
   * bad tick doesn't kill the loop — it just skips and reschedules.
   */
  async function runTick(query: string): Promise<void> {
    if (stopped) return;
    if (inFlight) return; // never overlap ticks
    inFlight = true;
    try {
      // Allowance gate — pause rather than drain the budget. Prefer an injected
      // reader (real on-chain/SQLite allowance); otherwise use the internal
      // soft session budget.
      const gateRemaining = readAllowanceWei
        ? await readAllowanceWei()
        : sessionBudget - spentWei;
      // The shared spend guard is the single hard ceiling across the loop AND
      // the manual endpoint — stop when either the loop's own budget or the
      // shared session cap is exhausted.
      const sharedRemaining = remainingSessionWei();
      if (
        (gateRemaining !== null && gateRemaining < floor + tickCost) ||
        sharedRemaining < tickCost
      ) {
        paused = true;
        if (timer !== null) {
          clearTimer(timer);
          timer = null;
        }
        return;
      }

      publish({
        type: "agent.loop.tick",
        ts: now(),
        query,
        queuedAt: now(),
      });

      // Per-tick identity lookup. The dashboard's browser-adoption flow swaps
      // the singleton at runtime; reading it here (not capturing opts.userPrimaryEOA
      // at startup) lets the loop re-key live. Env/plugin-mode deployments fall
      // back to the boot-time opts.userPrimaryEOA.
      const { _peekCached } = await import("./owner-identity");
      const effective = _peekCached();
      const userPrimaryEOA =
        effective?.source === "browser" && effective.ownerAddress
          ? effective.ownerAddress
          : opts.userPrimaryEOA;

      const cycle = await runCiteCycle({
        query,
        userPrimaryEOA,
        k,
        citeTopN,
        actionLabel: "auto",
        sessionId: "autonomous-loop",
        deps: cycleDeps,
      });

      if (cycle.act === null) {
        // Nothing to cite — recall came back empty. Skip allowance accounting.
        return;
      }

      // Allowance accounting. Charge the estimated tick cost against either the
      // injected reader or the internal soft budget, and report a real
      // decrementing remaining + runway.
      spentWei += tickCost;
      recordSpend(tickCost); // count toward the shared session cap (loop + manual)
      const rawRemaining = readAllowanceWei
        ? ((await readAllowanceWei()) ?? 0n)
        : sessionBudget - spentWei;
      const remaining = rawRemaining < 0n ? 0n : rawRemaining;
      // Float math: integer bigint division truncated runway to 0s at low budget,
      // which a judge reads off the live dashboard. Compute in float.
      const runwaySeconds =
        tickCost > 0n
          ? (Number(remaining) / Number(tickCost)) * cadenceSeconds
          : 0;
      publish({
        type: "allowance.spent",
        ts: now(),
        wei: tickCost.toString(),
        remainingWei: remaining.toString(),
        runwaySeconds,
      });

      // Semantic consolidation: periodically distil any memory that crossed the
      // working→episodic→semantic threshold into a RULE entity. Cheap no-op
      // unless something is ready. Wrapped so a distill failure never kills the
      // loop.
      completedTicks += 1;
      if (completedTicks % distillEveryNTicks === 0) {
        try {
          await distill(opts.userPrimaryEOA);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(
            `[cortex/loop] distill skipped: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err) {
      // Quietly skip — the loop must survive transient failures (rate limits,
      // RPC blips). Logged for the operator; no event emitted for a non-tick.
      // eslint-disable-next-line no-console
      console.warn(
        `[cortex/loop] tick skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      inFlight = false;
    }
  }

  // Kick off.
  schedule(initialDelayMs);

  return {
    pause() {
      paused = true;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
    },
    resume() {
      if (stopped || !paused) return;
      paused = false;
      schedule(cadenceMs);
    },
    async interrupt(query: string) {
      if (stopped) return;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      await runTick(query);
      schedule(cadenceMs);
    },
    isPaused() {
      return paused;
    },
    isStopped() {
      return stopped;
    },
    stop() {
      stopped = true;
      paused = true;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
    },
  };
}

/**
 * Default curated query pool. These map to memories seeded by the demo /
 * seed scripts so recall always returns relevant hits. Override via options.
 */
export const DEFAULT_QUERY_POOL: string[] = [
  "What did we learn about Solidity reentrancy?",
  "What's the most cost-effective way to compress embeddings?",
  "How does MMR proof verification work in Cortex?",
  "What ERC standards does Cortex compose?",
  "Why does accumulative extend matter for agent memory?",
  "What's the difference between $creator and $owner?",
  "How does the Synaptic Market price encrypted rules?",
  "What is the Darwinian primitive in Cortex?",
];
