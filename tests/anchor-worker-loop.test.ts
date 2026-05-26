/**
 * Optimistic Memory Buffering — anchor-worker BACKGROUND LOOP tests (offline).
 *
 * tests/anchor-worker.test.ts covers drainBundle/drainOutbox (the pure drain
 * sequence). This file covers startAnchorWorker — the scheduling shell around
 * it — with a fully INJECTED timer so the loop runs deterministically without
 * real time or Braga:
 *   - tickNow() forces an immediate drain and resolves with the results
 *   - a successful drain reschedules at idleMs; a failed drain backs off to
 *     backoffMs (outage-aware cadence)
 *   - the `draining` re-entrancy flag drops a tick that fires while a drain is
 *     still in flight (no double-drain of the same bundle)
 *   - stop() halts scheduling and is observable via isStopped()
 *   - pendingCount() reflects the live outbox depth (the dashboard line)
 *   - the auto-scheduled boot tick drains without an explicit tickNow()
 *
 * The injected timer is a manual scheduler: setTimer records the pending
 * callback instead of arming a real timer, and a fireTimer() helper invokes it.
 * This makes every scheduling decision assertable and the suite instant.
 */

import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import type { Hex } from "@arkiv-network/sdk";
import { act } from "../src/darwinian/citation.ts";
import { countOutbox } from "../src/mirror/db.ts";
import {
  startAnchorWorker,
  type DrainDeps,
} from "../src/agent/anchor-worker.ts";

const FAKE_USER = "0xCAfeBABe00000000000000000000000000000000" as Hex;
const KEY_A = "0xaaaa111111111111111111111111111111111111111111111111111111111111" as Hex;
const ROOT = ("0x" + "ab".repeat(32)) as Hex;
const CITE_ENTITY = ("0xc174" + "0".repeat(60)) as Hex;

const SCHEMA_PATH = new URL("../src/mirror/schema.sql", import.meta.url);

async function freshDb(): Promise<Database> {
  const db = new Database(":memory:");
  db.exec(await Bun.file(SCHEMA_PATH).text());
  return db;
}

async function enqueueCite(db: Database, key: Hex, sessionId: string): Promise<void> {
  await act({
    action: `cite ${sessionId}`,
    citations: [key],
    userPrimaryEOA: FAKE_USER,
    sessionId,
    _deps: {
      db,
      lastRecallIds: () => new Set([key]),
      entityTypeOf: () => "observation",
    },
  });
}

function okDeps(): DrainDeps {
  return {
    reinforce: async () => "0xreinforce",
    promote: async () => ({ txHash: "0xpromote" }),
    createCitation: async () => ({ entityKey: CITE_ENTITY, txHash: "0xcite" as Hex }),
    appendLeaf: async () => {},
    commitAnchor: async () => ({ rootHex: ROOT, txHash: "0xanchor" as Hex }),
  };
}

/**
 * A manual scheduler standing in for setTimeout. Records the (cb, ms) of the
 * single live timer and lets the test fire it on demand — deterministic, no
 * wall-clock waits. The worker only ever has one timer armed at a time
 * (schedule() clears the prior one before arming), which this models with a
 * single slot.
 */
function manualScheduler() {
  let nextId = 1;
  let pending: { id: number; cb: () => void; ms: number } | null = null;
  const lastMsHistory: number[] = [];
  return {
    setTimer(cb: () => void, ms: number): number {
      const id = nextId++;
      pending = { id, cb, ms };
      lastMsHistory.push(ms);
      return id;
    },
    clearTimer(h: ReturnType<typeof setTimeout> | number): void {
      if (pending && pending.id === (h as number)) pending = null;
    },
    /** The delay the worker last scheduled with. */
    lastMs(): number | undefined {
      return lastMsHistory[lastMsHistory.length - 1];
    },
    msHistory(): number[] {
      return lastMsHistory;
    },
    hasPending(): boolean {
      return pending !== null;
    },
    /** Invoke the currently-armed callback (simulates the timer elapsing). */
    fire(): void {
      if (!pending) throw new Error("manualScheduler.fire(): no timer armed");
      pending.cb();
    },
  };
}

const IDLE = 3_000;
const BACKOFF = 15_000;

describe("startAnchorWorker — tickNow drains immediately", () => {
  test("tickNow() drains the queue and reschedules at idleMs on success", async () => {
    const db = await freshDb();
    await enqueueCite(db, KEY_A, "s1");
    const sched = manualScheduler();

    const worker = startAnchorWorker({
      db,
      deps: okDeps(),
      idleMs: IDLE,
      backoffMs: BACKOFF,
      setTimer: sched.setTimer,
      clearTimer: sched.clearTimer,
    });

    // Boot scheduled an idle timer but did not run yet.
    expect(countOutbox(db, "pending")).toBe(1);

    const results = await worker.tickNow();

    expect(results.length).toBe(1);
    expect(results[0]?.ok).toBe(true);
    expect(countOutbox(db, "sent")).toBe(1);
    expect(countOutbox(db, "pending")).toBe(0);
    // Success → next poll armed at the idle cadence.
    expect(sched.lastMs()).toBe(IDLE);

    worker.stop();
  });
});

describe("startAnchorWorker — outage backoff cadence", () => {
  test("a failed drain reschedules at backoffMs (not idleMs)", async () => {
    const db = await freshDb();
    await enqueueCite(db, KEY_A, "s1");
    const sched = manualScheduler();

    const worker = startAnchorWorker({
      db,
      deps: {
        reinforce: async () => {
          throw new Error("braga down");
        },
      },
      idleMs: IDLE,
      backoffMs: BACKOFF,
      setTimer: sched.setTimer,
      clearTimer: sched.clearTimer,
    });

    const results = await worker.tickNow();

    expect(results.length).toBe(1);
    expect(results[0]?.ok).toBe(false);
    // Bundle stays pending for retry.
    expect(countOutbox(db, "pending")).toBe(1);
    // Failure → back off.
    expect(sched.lastMs()).toBe(BACKOFF);

    worker.stop();
  });

  test("empty queue reschedules at idleMs (no work, no backoff)", async () => {
    const db = await freshDb();
    const sched = manualScheduler();

    const worker = startAnchorWorker({
      db,
      deps: okDeps(),
      idleMs: IDLE,
      backoffMs: BACKOFF,
      setTimer: sched.setTimer,
      clearTimer: sched.clearTimer,
    });

    const results = await worker.tickNow();

    expect(results.length).toBe(0);
    expect(sched.lastMs()).toBe(IDLE);

    worker.stop();
  });
});

describe("startAnchorWorker — auto-scheduled boot tick", () => {
  test("firing the boot timer drains without an explicit tickNow()", async () => {
    const db = await freshDb();
    await enqueueCite(db, KEY_A, "s1");
    const sched = manualScheduler();

    startAnchorWorker({
      db,
      deps: okDeps(),
      idleMs: IDLE,
      backoffMs: BACKOFF,
      setTimer: sched.setTimer,
      clearTimer: sched.clearTimer,
    });

    // Boot armed a timer at idleMs but hasn't run.
    expect(sched.lastMs()).toBe(IDLE);
    expect(countOutbox(db, "pending")).toBe(1);

    // Simulate the timer elapsing. run() is async + fire-and-forgotten via
    // `void run()`, so yield the microtask queue for it to settle.
    sched.fire();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));

    expect(countOutbox(db, "sent")).toBe(1);
    expect(countOutbox(db, "pending")).toBe(0);
  });
});

describe("startAnchorWorker — re-entrancy guard", () => {
  test("a tick that fires mid-drain is dropped (no double-drain)", async () => {
    const db = await freshDb();
    await enqueueCite(db, KEY_A, "s1");
    const sched = manualScheduler();

    // A reinforce that blocks until we release it — lets us hold a drain open
    // and fire a second tick while the first is still in flight.
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((r) => {
      releaseFirst = r;
    });
    let reinforceCalls = 0;
    const deps: DrainDeps = {
      reinforce: async () => {
        reinforceCalls++;
        if (reinforceCalls === 1) await firstHeld; // hold the first drain open
        return "0xreinforce";
      },
      promote: async () => ({ txHash: "0xpromote" }),
      createCitation: async () => ({ entityKey: CITE_ENTITY, txHash: "0xcite" as Hex }),
      appendLeaf: async () => {},
      commitAnchor: async () => ({ rootHex: ROOT, txHash: "0xanchor" as Hex }),
    };

    const worker = startAnchorWorker({
      db,
      deps,
      idleMs: IDLE,
      backoffMs: BACKOFF,
      setTimer: sched.setTimer,
      clearTimer: sched.clearTimer,
    });

    // Start a drain but DON'T await it — it parks on `firstHeld`.
    const firstTick = worker.tickNow();
    await Promise.resolve(); // let run() reach the awaited reinforce

    // A second tick while draining=true must be a no-op (returns []).
    const secondTick = await worker.tickNow();
    expect(secondTick).toEqual([]);
    // The held drain hasn't called reinforce a second time.
    expect(reinforceCalls).toBe(1);

    // Release the first drain; it completes the single bundle.
    releaseFirst();
    const firstResults = await firstTick;
    expect(firstResults.length).toBe(1);
    expect(firstResults[0]?.ok).toBe(true);
    expect(reinforceCalls).toBe(1);
    expect(countOutbox(db, "sent")).toBe(1);

    worker.stop();
  });
});

describe("startAnchorWorker — stop()", () => {
  test("stop() sets isStopped and prevents further scheduling", async () => {
    const db = await freshDb();
    await enqueueCite(db, KEY_A, "s1");
    const sched = manualScheduler();

    const worker = startAnchorWorker({
      db,
      deps: okDeps(),
      idleMs: IDLE,
      backoffMs: BACKOFF,
      setTimer: sched.setTimer,
      clearTimer: sched.clearTimer,
    });

    expect(worker.isStopped()).toBe(false);
    worker.stop();
    expect(worker.isStopped()).toBe(true);
    // The armed timer was cleared by stop().
    expect(sched.hasPending()).toBe(false);

    // A stopped worker's run() short-circuits — tickNow drains nothing and does
    // not arm a new timer.
    const results = await worker.tickNow();
    expect(results).toEqual([]);
    expect(sched.hasPending()).toBe(false);
    // The bundle was never drained.
    expect(countOutbox(db, "pending")).toBe(1);
    expect(countOutbox(db, "sent")).toBe(0);
  });
});

describe("startAnchorWorker — pendingCount", () => {
  test("pendingCount reflects live outbox depth before and after a drain", async () => {
    const db = await freshDb();
    await enqueueCite(db, KEY_A, "s1");
    await enqueueCite(db, KEY_A, "s2");
    const sched = manualScheduler();

    const worker = startAnchorWorker({
      db,
      deps: okDeps(),
      idleMs: IDLE,
      backoffMs: BACKOFF,
      setTimer: sched.setTimer,
      clearTimer: sched.clearTimer,
    });

    expect(worker.pendingCount()).toBe(2);

    await worker.tickNow();

    expect(worker.pendingCount()).toBe(0);
    expect(countOutbox(db, "sent")).toBe(2);

    worker.stop();
  });
});
