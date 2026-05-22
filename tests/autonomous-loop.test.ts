/**
 * Tests for src/agent/autonomous-loop.ts.
 *
 * Strategy:
 *   - Tick CONTENT is driven via `interrupt(query)` (returns a promise we await),
 *     so assertions on emitted events + recall/act calls are deterministic.
 *   - SCHEDULING is asserted via an injected fake timer (no real wall-clock).
 *   - Allowance gating + error skipping are exercised with injected deps.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import type { Hex } from "@arkiv-network/sdk";
import {
  startAutonomousLoop,
  type AutonomousLoopDeps,
} from "../src/agent/autonomous-loop";
import {
  subscribe,
  _resetBus,
  type BufferedEvent,
  type DomainEventType,
} from "../src/lib/events";
import { _resetSpendGuard } from "../src/agent/spend-guard";
import type { MemoryHit } from "../src/darwinian/recall";
import type { ActResult, ActOptions } from "../src/darwinian/citation";

const EOA = ("0x" + "1".repeat(40)) as Hex;

function hit(key: string, score = 1): MemoryHit {
  return {
    entityKey: ("0x" + key.padEnd(64, "0")) as Hex,
    entityType: "observation",
    score,
    expiresAtBlock: 1000,
    attributes: [{ key: "entityType", value: "observation" }],
  };
}

function stubActResult(citations: Hex[]): ActResult {
  return {
    action: "stub",
    citations,
    extendedKeys: citations,
    promotedKeys: [],
    txHashes: ["0xtx"],
    citationEntityKey: ("0x" + "c".repeat(64)) as Hex,
    stateRootAnchor: null,
  };
}

/** Fake timer harness — records scheduled callbacks; never fires on its own. */
function makeFakeTimer() {
  let seq = 0;
  const scheduled = new Map<number, { cb: () => void; ms: number }>();
  const calls: number[] = [];
  const deps = {
    setTimer: (cb: () => void, ms: number) => {
      const h = ++seq;
      scheduled.set(h, { cb, ms });
      calls.push(ms);
      return h;
    },
    clearTimer: (h: number | ReturnType<typeof setTimeout>) => {
      scheduled.delete(h as number);
    },
  };
  return {
    deps,
    /** All ms values passed to setTimer, in order. */
    scheduledMs: () => calls.slice(),
    pendingCount: () => scheduled.size,
  };
}

/** Fake timer whose latest scheduled callback can be fired on demand. */
function makeDrivableTimer() {
  let seq = 0;
  let latest: { cb: () => void; handle: number } | null = null;
  const live = new Set<number>();
  const deps = {
    setTimer: (cb: () => void, _ms: number) => {
      const h = ++seq;
      latest = { cb, handle: h };
      live.add(h);
      return h;
    },
    clearTimer: (h: number | ReturnType<typeof setTimeout>) => {
      live.delete(h as number);
    },
  };
  return {
    deps,
    /** Fire the most recently scheduled (still-live) timer + flush the async tick. */
    async fire() {
      if (!latest || !live.has(latest.handle)) return;
      const cb = latest.cb;
      live.delete(latest.handle);
      cb();
      // Flush microtasks: the cb kicks an async tick chain (recall→act resolve
      // immediately under mocks). A macrotask turn drains it.
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

/** Collect events off the bus in arrival order. Returns a getter + unsub. */
function collectEvents() {
  const events: BufferedEvent[] = [];
  const unsub = subscribe((e) => events.push(e));
  return {
    types: () => events.map((e) => e.type),
    ofType: (t: DomainEventType) => events.filter((e) => e.type === t),
    unsub,
  };
}

describe("autonomous loop — tick content (via interrupt)", () => {
  beforeEach(() => {
    _resetBus();
    _resetSpendGuard();
  });

  test("one interrupt emits tick → recall.completed → allowance.spent and calls recall+act", async () => {
    const recallCalls: { query: string; k?: number }[] = [];
    const actCalls: ActOptions[] = [];
    const deps: AutonomousLoopDeps = {
      recall: async (o) => {
        recallCalls.push(o);
        return [hit("aa"), hit("bb"), hit("cc")];
      },
      act: async (o) => {
        actCalls.push(o);
        return stubActResult(o.citations);
      },
      setTimer: () => 1,
      clearTimer: () => {},
    };
    const collected = collectEvents();
    const loop = startAutonomousLoop({
      queryPool: ["q1"],
      userPrimaryEOA: EOA,
      _deps: deps,
    });

    await loop.interrupt("my query");
    loop.stop();
    collected.unsub();

    expect(recallCalls.length).toBe(1);
    expect(recallCalls[0]!.query).toBe("my query");
    expect(actCalls.length).toBe(1);
    expect(actCalls[0]!.action).toBe("auto: my query");
    // Default citeTopN = 1 → only the top hit is cited.
    expect(actCalls[0]!.citations).toEqual([hit("aa").entityKey]);

    const types = collected.types();
    expect(types).toContain("agent.loop.tick");
    expect(types).toContain("recall.completed");
    expect(types).toContain("allowance.spent");
    // Order: tick before recall.completed before allowance.spent.
    expect(types.indexOf("agent.loop.tick")).toBeLessThan(
      types.indexOf("recall.completed"),
    );
    expect(types.indexOf("recall.completed")).toBeLessThan(
      types.indexOf("allowance.spent"),
    );
  });

  test("citeTopN controls how many hits are cited", async () => {
    const actCalls: ActOptions[] = [];
    const loop = startAutonomousLoop({
      queryPool: ["q1"],
      userPrimaryEOA: EOA,
      citeTopN: 3,
      _deps: {
        recall: async () => [hit("aa"), hit("bb"), hit("cc"), hit("dd")],
        act: async (o) => {
          actCalls.push(o);
          return stubActResult(o.citations);
        },
        setTimer: () => 1,
        clearTimer: () => {},
      },
    });
    await loop.interrupt("q");
    loop.stop();
    expect(actCalls[0]!.citations.length).toBe(3);
  });

  test("empty recall → recall.completed with null selected, act NOT called", async () => {
    let actCalled = false;
    const collected = collectEvents();
    const loop = startAutonomousLoop({
      queryPool: ["q1"],
      userPrimaryEOA: EOA,
      _deps: {
        recall: async () => [],
        act: async (o) => {
          actCalled = true;
          return stubActResult(o.citations);
        },
        setTimer: () => 1,
        clearTimer: () => {},
      },
    });
    await loop.interrupt("q");
    loop.stop();
    collected.unsub();

    expect(actCalled).toBe(false);
    const recallDone = collected.ofType("recall.completed");
    expect(recallDone.length).toBe(1);
    const ev = recallDone[0]!.event;
    if (ev.type !== "recall.completed") throw new Error("narrowing");
    expect(ev.selectedId).toBeNull();
    // No allowance.spent when nothing was cited.
    expect(collected.ofType("allowance.spent").length).toBe(0);
  });

  test("recall throwing (e.g. Cohere 429) is swallowed — loop survives", async () => {
    const loop = startAutonomousLoop({
      queryPool: ["q1"],
      userPrimaryEOA: EOA,
      _deps: {
        recall: async () => {
          throw new Error("429 rate limited");
        },
        act: async (o) => stubActResult(o.citations),
        setTimer: () => 1,
        clearTimer: () => {},
      },
    });
    // Should not reject.
    await expect(loop.interrupt("q")).resolves.toBeUndefined();
    expect(loop.isStopped()).toBe(false);
    loop.stop();
  });
});

describe("autonomous loop — allowance gate", () => {
  beforeEach(() => {
    _resetBus();
    _resetSpendGuard();
  });

  test("pauses (and skips act) when remaining < floor + tickCost", async () => {
    let actCalled = false;
    const loop = startAutonomousLoop({
      queryPool: ["q1"],
      userPrimaryEOA: EOA,
      allowanceFloorWei: 0n,
      estimatedTickCostWei: 100n,
      _deps: {
        readAllowanceWei: async () => 50n, // below 0 + 100
        recall: async () => [hit("aa")],
        act: async (o) => {
          actCalled = true;
          return stubActResult(o.citations);
        },
        setTimer: () => 1,
        clearTimer: () => {},
      },
    });
    await loop.interrupt("q");
    expect(actCalled).toBe(false);
    expect(loop.isPaused()).toBe(true);
    loop.stop();
  });

  test("proceeds when remaining >= floor + tickCost", async () => {
    let actCalled = false;
    const loop = startAutonomousLoop({
      queryPool: ["q1"],
      userPrimaryEOA: EOA,
      allowanceFloorWei: 0n,
      estimatedTickCostWei: 100n,
      _deps: {
        readAllowanceWei: async () => 1_000n,
        recall: async () => [hit("aa")],
        act: async (o) => {
          actCalled = true;
          return stubActResult(o.citations);
        },
        setTimer: () => 1,
        clearTimer: () => {},
      },
    });
    await loop.interrupt("q");
    expect(actCalled).toBe(true);
    expect(loop.isPaused()).toBe(false);
    loop.stop();
  });
});

describe("autonomous loop — scheduling", () => {
  beforeEach(() => {
    _resetBus();
    _resetSpendGuard();
  });

  test("first tick is scheduled at initialDelayMs", () => {
    const timer = makeFakeTimer();
    const loop = startAutonomousLoop({
      queryPool: ["q1"],
      userPrimaryEOA: EOA,
      initialDelayMs: 1234,
      cadenceMs: 9999,
      _deps: {
        ...timer.deps,
        recall: async () => [hit("aa")],
        act: async (o) => stubActResult(o.citations),
      },
    });
    expect(timer.scheduledMs()[0]).toBe(1234);
    loop.stop();
  });

  test("after a tick, next is scheduled at cadenceMs", async () => {
    const timer = makeFakeTimer();
    const loop = startAutonomousLoop({
      queryPool: ["q1"],
      userPrimaryEOA: EOA,
      initialDelayMs: 1234,
      cadenceMs: 9999,
      _deps: {
        ...timer.deps,
        recall: async () => [hit("aa")],
        act: async (o) => stubActResult(o.citations),
      },
    });
    await loop.interrupt("q");
    const ms = timer.scheduledMs();
    // [initialDelay, cadence-from-interrupt-reschedule]
    expect(ms[ms.length - 1]).toBe(9999);
    loop.stop();
  });

  test("pause clears pending timer; resume reschedules", () => {
    const timer = makeFakeTimer();
    const loop = startAutonomousLoop({
      queryPool: ["q1"],
      userPrimaryEOA: EOA,
      cadenceMs: 5000,
      _deps: {
        ...timer.deps,
        recall: async () => [hit("aa")],
        act: async (o) => stubActResult(o.citations),
      },
    });
    expect(timer.pendingCount()).toBe(1);
    loop.pause();
    expect(timer.pendingCount()).toBe(0);
    expect(loop.isPaused()).toBe(true);
    loop.resume();
    expect(timer.pendingCount()).toBe(1);
    expect(loop.isPaused()).toBe(false);
    loop.stop();
  });

  test("stop makes the handle inert (no scheduling, isStopped true)", () => {
    const timer = makeFakeTimer();
    const loop = startAutonomousLoop({
      queryPool: ["q1"],
      userPrimaryEOA: EOA,
      _deps: {
        ...timer.deps,
        recall: async () => [hit("aa")],
        act: async (o) => stubActResult(o.citations),
      },
    });
    loop.stop();
    expect(loop.isStopped()).toBe(true);
    expect(timer.pendingCount()).toBe(0);
    loop.resume(); // no-op after stop
    expect(timer.pendingCount()).toBe(0);
  });

  test("auto-tick query rotation avoids immediate repeat", async () => {
    const seen: string[] = [];
    const timer = makeDrivableTimer();
    const loop = startAutonomousLoop({
      queryPool: ["A", "B"],
      userPrimaryEOA: EOA,
      initialDelayMs: 1,
      cadenceMs: 1,
      _deps: {
        ...timer.deps,
        // random()=0 → always index 0; pickQuery must bump to 1 when it equals
        // the last index, producing A then B.
        random: () => 0,
        recall: async ({ query }) => {
          seen.push(query);
          return [hit("aa")];
        },
        act: async (o) => stubActResult(o.citations),
      },
    });
    await timer.fire(); // first auto tick
    await timer.fire(); // second auto tick (rescheduled after first)
    loop.stop();
    expect(seen).toEqual(["A", "B"]);
  });
});
