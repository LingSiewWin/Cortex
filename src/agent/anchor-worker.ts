/**
 * Cortex — anchor worker (Optimistic Memory Buffering, Phase 1).
 *
 * The single serialized writer that drains the durable outbox act() fills.
 * act() commits scoring locally and enqueues an `act_bundle`; this worker pulls
 * pending bundles oldest-first and fires the on-chain sequence against Braga:
 *
 *     extend → promote → write CITATION entity → MMR append → state-root anchor
 *
 * On success it records the tx hashes + the citation entity key on the outbox
 * row (status='sent') and marks the cited memories verified=true under the
 * anchored root (reconciliation — verifyScoreInclusion now works for them).
 * On failure the row stays 'pending' (attempts++), so a restart or the next
 * tick retries — memories are never lost, just unanchored until Braga returns.
 *
 * Being the SOLE writer of the session key also serializes nonce usage, which
 * is why this also fixes the concurrent-nonce-contention bug: act() no longer
 * races the loop for the wallet — only the worker touches it.
 *
 * Failure semantics are at-least-once. A bundle that fails mid-sequence (e.g.
 * extend lands, then create reverts) is retried whole. Re-extending an
 * already-cited memory only lengthens its (deserved) lease, and a duplicate
 * CITATION audit row is harmless; the common failure mode — Braga down — fails
 * the first call so nothing partial lands. (A per-step journal is V2.)
 */

import type { Database } from "bun:sqlite";
import type { Hex } from "@arkiv-network/sdk";
import { ExpirationTime } from "@arkiv-network/sdk/utils";
import { hexToBytes } from "viem";
import {
  initMirrorDb,
  listPendingOutbox,
  markOutboxSent,
  markOutboxFailed,
  markOutboxDead,
  markVerified,
  setPayloadHash,
  countOutbox,
  type OutboxRow,
} from "../mirror/db.ts";
import { reinforceBatch } from "../darwinian/extend.ts";
import { promoteOwnership } from "../lib/ownership.ts";
import { singleCreate } from "../lib/batch-writer.ts";
import { appendToStateMMR } from "../mirror/state.ts";
import { commitAndAnchor } from "../mirror/anchor.ts";
import { ChainHealthDetector, type ChainMode } from "../mirror/chain-health.ts";

/** The on-chain side effects, injectable so tests drain without touching Braga. */
export interface DrainDeps {
  /** Accumulative extend batch. Default: reinforceBatch(). */
  reinforce?: (
    items: { entityKey: Hex; reinforcementSeconds: number }[],
  ) => Promise<string>;
  /** Ownership transfer session-key → user EOA. Default: promoteOwnership(). */
  promote?: (keys: readonly Hex[], userEOA: Hex) => Promise<{ txHash: string }>;
  /** Write the CITATION entity from the exact stored bytes. Default: singleCreate(). */
  createCitation?: (input: {
    payload: Uint8Array;
    attributes: { key: string; value: string | number }[];
  }) => Promise<{ entityKey: Hex; txHash: string }>;
  /** Append the citation leaf to the process MMR. Default: appendToStateMMR(). */
  appendLeaf?: (payloadHashHex: Hex) => Promise<void>;
  /** Commit + anchor the current MMR root on Braga. Default: commitAndAnchor(). */
  commitAnchor?: () => Promise<{ rootHex: Hex; txHash: Hex }>;
}

export interface DrainResult {
  outboxId: number;
  ok: boolean;
  txHashes: string[];
  citationEntityKey: Hex | null;
  rootHex: Hex | null;
  error?: string;
}

/** CITATION audit entities are long-lived but not permanent — 30 days. */
const CITATION_EXPIRY_SECONDS = ExpirationTime.fromDays(30);

/**
 * Retry budget before a bundle is dead-lettered (status='failed'). Without a cap,
 * a permanently-failing bundle (malformed payload, an entity the precompile always
 * rejects) retries forever AND head-of-line-blocks every later bundle, while burning
 * gas re-broadcasting a reverting tx. After this many attempts we give up on it.
 */
const MAX_ATTEMPTS = 8;

function resolveDeps(deps?: DrainDeps): Required<DrainDeps> {
  return {
    reinforce: deps?.reinforce ?? ((items) => reinforceBatch(items)),
    promote:
      deps?.promote ??
      (async (keys, eoa) => {
        const r = await promoteOwnership(keys, eoa);
        return { txHash: r.txHash };
      }),
    createCitation:
      deps?.createCitation ??
      (async (input) => {
        const { entityKey, txHash } = await singleCreate({
          payload: input.payload,
          contentType: "application/json",
          attributes: input.attributes,
          expiresInSeconds: CITATION_EXPIRY_SECONDS,
        });
        return { entityKey, txHash };
      }),
    appendLeaf: deps?.appendLeaf ?? (async (h) => void (await appendToStateMMR(h))),
    commitAnchor:
      deps?.commitAnchor ??
      (async () => {
        const r = await commitAndAnchor("act");
        return { rootHex: r.rootHex, txHash: r.txHash };
      }),
  };
}

/**
 * Execute one bundle's on-chain sequence. Throws on the first failing step so
 * the caller can mark the row failed (it stays pending for retry). On success,
 * reconciles the outbox row + the cited rows in a single pass.
 */
export async function drainBundle(
  db: Database,
  row: OutboxRow,
  deps?: DrainDeps,
): Promise<DrainResult> {
  const d = resolveDeps(deps);
  const b = row.bundle;
  const txHashes: string[] = [];

  try {
    // 1. Accumulative extend on every cited memory.
    if (b.reinforceItems.length > 0) {
      const tx = await d.reinforce(
        b.reinforceItems.map((i) => ({
          entityKey: i.entityKey as Hex,
          reinforcementSeconds: i.reinforcementSeconds,
        })),
      );
      txHashes.push(tx);
    }

    // 2. Ownership transfer for memories promoted working→episodic this act.
    if (b.promotionsToEpisode.length > 0) {
      const { txHash } = await d.promote(
        b.promotionsToEpisode as Hex[],
        b.userPrimaryEOA as Hex,
      );
      txHashes.push(txHash);
    }

    // 3. Write the CITATION entity from the EXACT bytes act() built (so the
    // on-chain payload hashes to the leaf the MMR will commit to).
    const { entityKey, txHash: citeTx } = await d.createCitation({
      payload: hexToBytes(b.citationPayloadHex as Hex),
      attributes: b.citationAttributes,
    });
    txHashes.push(citeTx);

    // 4. Append the citation leaf (idempotent — appendToStateMMR dedups, so the
    // daemon re-observing this same CITATION entity later is a no-op), then anchor
    // the new root. The best-effort setPayloadHash is a no-op until the daemon
    // ingests the entity row; durable leaf persistence for cold-restart rebuild
    // comes from that daemon sync (the entity is already on-chain post-create).
    setPayloadHash(db, entityKey, b.citationPayloadHashHex as Hex);
    await d.appendLeaf(b.citationPayloadHashHex as Hex);
    const anchor = await d.commitAnchor();
    txHashes.push(anchor.txHash);

    // 5. Reconcile ATOMICALLY: marking the outbox row sent and flipping the cited
    // rows verified must both land or neither — else a crash between them leaves a
    // row 'sent' (never retried) with memories stuck verified=0, silently breaking
    // verifyScoreInclusion. One transaction closes that split-brain window.
    db.transaction(() => {
      markOutboxSent(db, row.id, txHashes, entityKey);
      markVerified(db, b.citations, anchor.rootHex);
    })();

    return {
      outboxId: row.id,
      ok: true,
      txHashes,
      citationEntityKey: entityKey,
      rootHex: anchor.rootHex,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // attempts is the count BEFORE this failure; markOutboxFailed makes it +1.
    if (row.attempts + 1 >= MAX_ATTEMPTS) {
      markOutboxDead(db, row.id, `dead-lettered after ${row.attempts + 1} attempts: ${msg}`);
    } else {
      markOutboxFailed(db, row.id, msg);
    }
    return {
      outboxId: row.id,
      ok: false,
      txHashes,
      citationEntityKey: null,
      rootHex: null,
      error: msg,
    };
  }
}

/**
 * Drain pending bundles oldest-first, one at a time (single serialized writer).
 * Stops at the first failure so a Braga outage doesn't burn attempts on every
 * queued bundle in a tight loop — the failed bundle stays pending and the next
 * call resumes from it. Returns the results of the bundles it attempted.
 */
export async function drainOutbox(
  db: Database,
  deps?: DrainDeps,
  maxBundles = 50,
): Promise<DrainResult[]> {
  const pending = listPendingOutbox(db, maxBundles);
  const results: DrainResult[] = [];
  for (const row of pending) {
    const result = await drainBundle(db, row, deps);
    results.push(result);
    if (!result.ok) break; // back off — likely a chain-wide outage
  }
  return results;
}

// ---------------------------------------------------------------------------
// Background worker loop
// ---------------------------------------------------------------------------

export interface AnchorWorkerOptions {
  /** Poll cadence when the queue is empty / after a success. Default 3_000ms. */
  idleMs?: number;
  /** Backoff cadence after a failed drain (Braga likely down). Default 15_000ms. */
  backoffMs?: number;
  /** Injected drain dependencies (tests). */
  deps?: DrainDeps;
  /** Injected timer (tests). Default setTimeout. */
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout> | number;
  clearTimer?: (h: ReturnType<typeof setTimeout> | number) => void;
  /** Injected mirror (tests). Default initMirrorDb(). */
  db?: Database;
  /**
   * Chain-health sampler (Sync plane). When wired, the worker becomes
   * HEALTH-ADAPTIVE: it samples head+spread each background tick and, when the
   * chain is STALLED, SKIPS draining (don't burn gas/nonces against a dead head);
   * when DEGRADED, drains one bundle at a time. When omitted, the worker always
   * drains (legacy behaviour). ui-server wires `() => sampleChainHead()`.
   */
  sampleHealth?: () => Promise<{ head: number; spread: number }>;
  /** Injected detector (tests). Default: a fresh ChainHealthDetector (fail-safe STALLED). */
  detector?: ChainHealthDetector;
}

export interface AnchorWorkerHandle {
  /** Force one drain pass now (await it), regardless of detected mode. Reschedules afterward. */
  tickNow(): Promise<DrainResult[]>;
  /** Pending bundle count — drives the "N formed / M anchored" dashboard line. */
  pendingCount(): number;
  /** Current detected chain mode (drives the dashboard health badge). */
  currentMode(): ChainMode;
  stop(): void;
  isStopped(): boolean;
}

const DEFAULT_IDLE_MS = 3_000;
const DEFAULT_BACKOFF_MS = 15_000;

/**
 * Start the background anchor worker. It polls the outbox on a cadence; an empty
 * or fully-drained queue reschedules at idleMs, a failed drain backs off to
 * backoffMs. The handle exposes tickNow() so the dashboard / a script can force
 * an immediate drain (e.g. right after a manual cite).
 */
export function startAnchorWorker(opts?: AnchorWorkerOptions): AnchorWorkerHandle {
  const idleMs = opts?.idleMs ?? DEFAULT_IDLE_MS;
  const backoffMs = opts?.backoffMs ?? DEFAULT_BACKOFF_MS;
  const setTimer = opts?.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer =
    opts?.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  const sampleHealth = opts?.sampleHealth;
  const detector = opts?.detector ?? new ChainHealthDetector();
  let dbRef: Database | null = opts?.db ?? null;
  let mode: ChainMode = detector.mode;
  let stopped = false;
  let draining = false;
  let timer: ReturnType<typeof setTimeout> | number | null = null;

  async function db(): Promise<Database> {
    if (!dbRef) dbRef = await initMirrorDb();
    return dbRef;
  }

  function schedule(ms: number): void {
    if (stopped) return;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => {
      void run(false);
    }, ms);
  }

  /**
   * One drain pass. `force` (tickNow / explicit human intent) drains regardless
   * of detected mode; the background timer passes force=false so a STALLED chain
   * is left alone instead of burning retries. Health is only sampled when a
   * sampler is wired — otherwise the worker always drains (legacy behaviour).
   */
  async function run(force: boolean): Promise<DrainResult[]> {
    if (stopped || draining) return [];
    draining = true;
    try {
      const conn = await db();

      if (sampleHealth) {
        try {
          mode = detector.observe(await sampleHealth());
        } catch {
          // A failed health sample is itself a stall signal — fail safe.
          mode = "stalled";
        }
        if (mode === "stalled" && !force) {
          // Don't drain into a frozen head; the agent keeps running locally.
          schedule(backoffMs);
          return [];
        }
      }

      // DEGRADED: inconsistent RPC pool → drain one bundle at a time + back off,
      // so a stale-node read-after-write failure can't cascade the whole queue.
      const maxBundles = mode === "degraded" ? 1 : 50;
      const results = await drainOutbox(conn, opts?.deps, maxBundles);
      const failed = results.some((r) => !r.ok);
      schedule(failed || mode === "degraded" ? backoffMs : idleMs);
      return results;
    } catch {
      // initMirrorDb / unexpected — back off and retry.
      schedule(backoffMs);
      return [];
    } finally {
      draining = false;
    }
  }

  // Kick off after one idle interval (lets the process settle).
  schedule(idleMs);

  return {
    async tickNow() {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      return run(true);
    },
    pendingCount() {
      return dbRef ? countOutbox(dbRef, "pending") : 0;
    },
    currentMode() {
      return mode;
    },
    stop() {
      stopped = true;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
    },
    isStopped() {
      return stopped;
    },
  };
}
