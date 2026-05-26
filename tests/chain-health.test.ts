/**
 * Chain-health detector tests (offline; deterministic clock).
 *
 * Proves the Sync-plane detector: correct classification, hysteresis (no flap
 * on a single bad sample), dwell (no transition faster than dwellMs), and the
 * fail-safe STALLED default. Correctness of Cortex data never depends on this —
 * but its behavior must be predictable so the worker adapts sanely.
 */

import { test, expect, describe } from "bun:test";
import {
  classifyObservation,
  ChainHealthDetector,
  sampleChainHead,
} from "../src/mirror/chain-health.ts";

describe("classifyObservation (pure)", () => {
  test("frozen head → stalled, regardless of spread", () => {
    expect(classifyObservation({ headAdvanced: false, spread: 0 })).toBe("stalled");
    expect(classifyObservation({ headAdvanced: false, spread: 999 })).toBe("stalled");
  });
  test("advancing + tight spread → healthy", () => {
    expect(classifyObservation({ headAdvanced: true, spread: 1 })).toBe("healthy");
    expect(classifyObservation({ headAdvanced: true, spread: 50 })).toBe("healthy");
  });
  test("advancing + wide spread → degraded", () => {
    expect(classifyObservation({ headAdvanced: true, spread: 51 })).toBe("degraded");
    expect(classifyObservation({ headAdvanced: true, spread: 37000 })).toBe("degraded");
  });
});

describe("ChainHealthDetector — hysteresis + dwell", () => {
  /** A controllable clock. */
  function clock(start = 0) {
    let t = start;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  }

  test("fail-safe default is STALLED before any observation", () => {
    const d = new ChainHealthDetector();
    expect(d.mode).toBe("stalled");
  });

  test("needs `confirm` consecutive healthy observations to leave STALLED", () => {
    const c = clock();
    const d = new ChainHealthDetector({ confirm: 2, dwellMs: 0, now: c.now });
    // First advance: head goes up, but only 1 confirmation → still stalled.
    d.observe({ head: 100, spread: 0 }); // first obs: no prior head → not advanced
    expect(d.mode).toBe("stalled");
    expect(d.observe({ head: 101, spread: 0 })).toBe("stalled"); // 1st healthy confirm
    expect(d.observe({ head: 102, spread: 0 })).toBe("healthy"); // 2nd → switch
  });

  test("a single bad (wide-spread) sample does NOT flap healthy→degraded", () => {
    const c = clock();
    const d = new ChainHealthDetector({ confirm: 2, dwellMs: 0, now: c.now });
    // Get to healthy.
    d.observe({ head: 1, spread: 0 });
    d.observe({ head: 2, spread: 0 });
    d.observe({ head: 3, spread: 0 });
    expect(d.mode).toBe("healthy");
    // One wide-spread blip → still healthy (only 1 confirm).
    expect(d.observe({ head: 4, spread: 9999 })).toBe("healthy");
    // Back to tight → resets pending, stays healthy.
    expect(d.observe({ head: 5, spread: 0 })).toBe("healthy");
    // Now two consecutive wide → degraded.
    expect(d.observe({ head: 6, spread: 9999 })).toBe("healthy"); // 1st
    expect(d.observe({ head: 7, spread: 9999 })).toBe("degraded"); // 2nd → switch
  });

  test("dwell blocks a transition until dwellMs has elapsed", () => {
    const c = clock();
    const d = new ChainHealthDetector({ confirm: 1, dwellMs: 10_000, now: c.now });
    // Reach healthy at t=0 (confirm=1 so it switches as soon as dwell allows).
    d.observe({ head: 1, spread: 0 });
    d.observe({ head: 2, spread: 0 }); // headAdvanced, candidate healthy, dwellOk (0-0>=10000? no)
    // lastTransitionAt starts 0, now=0 → dwell NOT ok → stays stalled.
    expect(d.mode).toBe("stalled");
    c.advance(10_000);
    expect(d.observe({ head: 3, spread: 0 })).toBe("healthy"); // dwell satisfied → switch
  });

  test("frozen head drives STALLED after confirmations", () => {
    const c = clock();
    const d = new ChainHealthDetector({ confirm: 2, dwellMs: 0, now: c.now });
    d.observe({ head: 10, spread: 0 });
    d.observe({ head: 11, spread: 0 });
    d.observe({ head: 12, spread: 0 });
    expect(d.mode).toBe("healthy");
    // Head freezes at 12.
    expect(d.observe({ head: 12, spread: 0 })).toBe("healthy"); // 1st stalled confirm
    expect(d.observe({ head: 12, spread: 0 })).toBe("stalled"); // 2nd → switch
  });
});

describe("sampleChainHead", () => {
  test("computes head (max) and spread (max−min) from injected samples", async () => {
    const seq = [100, 105, 100, 137_000, 101];
    let i = 0;
    const { head, spread } = await sampleChainHead({
      getHead: async () => seq[i++]!,
      samples: 5,
      gapMs: 0,
    });
    expect(head).toBe(137_000);
    expect(spread).toBe(137_000 - 100);
  });

  test("tolerates some failed samples", async () => {
    const seq = [() => 200, () => { throw new Error("rpc down"); }, () => 202];
    let i = 0;
    const { head, spread } = await sampleChainHead({
      getHead: async () => seq[i++]!(),
      samples: 3,
      gapMs: 0,
    });
    expect(head).toBe(202);
    expect(spread).toBe(2);
  });

  test("throws if every sample fails", async () => {
    await expect(
      sampleChainHead({ getHead: async () => { throw new Error("dead"); }, samples: 3, gapMs: 0 }),
    ).rejects.toThrow();
  });
});
