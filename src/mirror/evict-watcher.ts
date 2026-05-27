/**
 * Cortex — Evict watcher (the Darwinian payoff, live).
 *
 * Emits `memory.evicted` on the in-process event bus the moment a *live*
 * mirrored memory crosses its `expires_at_block`. The dashboard's
 * MemoryConstellation listens for this and animates the dot "fades, then
 * drops" — the emotional core of the decay story.
 *
 * Why a sweep here instead of the mirror daemon:
 *   - `bun run mirror` (daemon) and `bun run dashboard` (this SSE server) are
 *     SEPARATE processes. The event bus (src/lib/events.ts) is a per-process
 *     singleton, so a `publish()` inside the daemon never reaches the browser's
 *     /sse stream. The watcher therefore runs in the SSE server's own process,
 *     reading the shared SQLite mirror.
 *   - A lease crossing its expiry is exactly the signal the health bars already
 *     render (opacity → 0). Emitting eviction when the bar hits zero is
 *     consistent with what the viewer sees, and doesn't depend on the daemon
 *     running or on Braga's ArkivEntityExpired log arriving inside a 2–3 min
 *     demo window. The daemon still records the chain-confirmed eviction into
 *     `/api/decay` ("Recently evicted — free GC") as the on-chain proof.
 *
 * Honesty: the lease we paid for has elapsed; Arkiv auto-deletes expired
 * entities (no manual-delete gas). We do NOT claim the entity is provably
 * deleted on-chain at emit time — that's what the daemon's /api/decay path is
 * for. See docs/MIRROR.md §2.
 *
 * Every side-effecting dependency is injectable so tests drive deterministic
 * ticks (see tests/evict-watcher.test.ts).
 */

import type { Database } from "./db";
import type { Hex } from "@arkiv-network/sdk";
import { initMirrorDb } from "./db.ts";
import { publish as realPublish, type DomainEvent } from "../lib/events.ts";
import { ENTITY_TYPE } from "../constants.ts";

/** Arkiv's flat ~29k gas per CREATE — what a manual delete would have cost. */
const APPROX_DELETE_GAS = 29_000;
const DEFAULT_INTERVAL_MS = 5_000;

export type TimerHandle = ReturnType<typeof setTimeout> | number;

export interface EvictWatcherDeps {
  db?: Database;
  /** Returns the current block estimate (the SSE server already computes one). */
  currentBlock: () => Promise<number>;
  publish?: (event: DomainEvent) => unknown;
  setTimer?: (cb: () => void, ms: number) => TimerHandle;
  clearTimer?: (h: TimerHandle) => void;
  now?: () => number;
}

export interface EvictWatcherOptions {
  /** Milliseconds between sweeps. Default 5_000. */
  intervalMs?: number;
  deps: EvictWatcherDeps;
}

export interface EvictWatcherHandle {
  /** Run one sweep immediately (used by the scheduler and by tests). */
  sweep(): Promise<number>;
  /** Stop scheduling further sweeps. */
  stop(): void;
}

interface LiveRow {
  entity_key: Hex;
  expires_at_block: number;
  attributes_json: string | null;
}

/** Map the stamped `entityType` attribute to a spine tier name. */
function tierOf(attributesJson: string | null): "working" | "episodic" | "rule" {
  if (!attributesJson) return "working";
  try {
    const attrs = JSON.parse(attributesJson) as Array<{ key: string; value: string | number }>;
    for (const a of attrs) {
      if (a.key === "entityType") {
        if (a.value === ENTITY_TYPE.EPISODE) return "episodic";
        if (a.value === ENTITY_TYPE.RULE) return "rule";
      }
    }
  } catch {
    /* fall through to working */
  }
  return "working";
}

/**
 * Start the evict watcher. On start it seeds the "already evicted" set with
 * everything currently past expiry so we don't replay the historical graveyard
 * as fresh drops — only NEW crossings during this session emit an event.
 */
export async function startEvictWatcher(
  opts: EvictWatcherOptions,
): Promise<EvictWatcherHandle> {
  const db = opts.deps.db ?? (await initMirrorDb());
  const publish = opts.deps.publish ?? realPublish;
  const setTimer = opts.deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = opts.deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const now = opts.deps.now ?? (() => Date.now());
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;

  // Entities we've already emitted an eviction for this process — prevents
  // double-firing across sweeps. Seeded below with the historical graveyard.
  const emitted = new Set<Hex>();
  let stopped = false;
  let timer: TimerHandle | null = null;

  // Seed: anything already expired (state flag OR lease already elapsed) is
  // historical — record it so the first live sweep doesn't dump it all at once.
  {
    const block = await opts.deps.currentBlock();
    const seedRows = db
      .prepare(
        "SELECT entity_key, expires_at_block, attributes_json FROM entities " +
          "WHERE state = 'expired' OR (state = 'live' AND expires_at_block > 0 AND expires_at_block <= ?)",
      )
      .all(block) as LiveRow[];
    for (const r of seedRows) emitted.add(r.entity_key);
  }

  async function sweep(): Promise<number> {
    const block = await opts.deps.currentBlock();
    if (block <= 0) return 0;
    const rows = db
      .prepare(
        "SELECT entity_key, expires_at_block, attributes_json FROM entities " +
          "WHERE state = 'live' AND expires_at_block > 0 AND expires_at_block <= ? " +
          "ORDER BY expires_at_block ASC",
      )
      .all(block) as LiveRow[];

    let fired = 0;
    for (const r of rows) {
      if (emitted.has(r.entity_key)) continue;
      emitted.add(r.entity_key);
      publish({
        type: "memory.evicted",
        ts: now(),
        entityKey: r.entity_key,
        tier: tierOf(r.attributes_json),
        expiredAtBlock: r.expires_at_block,
        gasReclaimedEstimate: APPROX_DELETE_GAS,
      });
      fired += 1;
    }
    return fired;
  }

  const schedule = () => {
    if (stopped) return;
    timer = setTimer(() => {
      void sweep().finally(schedule);
    }, intervalMs);
  };
  schedule();

  return {
    sweep,
    stop() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}
