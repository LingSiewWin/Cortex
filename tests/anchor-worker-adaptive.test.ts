/**
 * Anchor worker — HEALTH-ADAPTIVE drain (offline).
 *
 * When a sampleHealth dep is wired, the background worker must:
 *   - SKIP draining when the detector reads STALLED (don't burn gas on a frozen head)
 *   - still drain on an explicit tickNow() even while STALLED (human intent)
 *   - drain normally once HEALTHY
 * Correctness of the queue never depends on the detector — only WHEN we drain.
 */

import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import type { Hex } from "@arkiv-network/sdk";
import { act } from "../src/darwinian/citation.ts";
import { countOutbox } from "../src/mirror/db.ts";
import { startAnchorWorker, type DrainDeps } from "../src/agent/anchor-worker.ts";
import { ChainHealthDetector } from "../src/mirror/chain-health.ts";

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
async function enqueueCite(db: Database, key: Hex, s: string): Promise<void> {
  await act({
    action: `cite ${s}`,
    citations: [key],
    userPrimaryEOA: FAKE_USER,
    sessionId: s,
    _deps: { db, lastRecallIds: () => new Set([key]), entityTypeOf: () => "observation" },
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
function manualScheduler() {
  let pending: { cb: () => void } | null = null;
  let lastMs = -1;
  return {
    setTimer(cb: () => void, ms: number) {
      pending = { cb };
      lastMs = ms;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer() {
      pending = null;
    },
    lastMs: () => lastMs,
    async fire() {
      pending?.cb();
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

describe("anchor worker — adaptive drain", () => {
  test("STALLED: background tick SKIPS draining (no gas burned on a frozen head)", async () => {
    const db = await freshDb();
    await enqueueCite(db, KEY_A, "s1");
    const sched = manualScheduler();
    // Frozen head: every sample returns the same block → detector → STALLED.
    const detector = new ChainHealthDetector({ confirm: 1, dwellMs: 0 });
    detector._setModeForTest("stalled");
    let reinforceCalls = 0;

    const worker = startAnchorWorker({
      db,
      detector,
      sampleHealth: async () => ({ head: 815854, spread: 0 }), // not advancing
      deps: { ...okDeps(), reinforce: async () => { reinforceCalls++; return "0xreinforce"; } },
      idleMs: 3000,
      backoffMs: 15000,
      setTimer: sched.setTimer,
      clearTimer: sched.clearTimer,
    });

    await sched.fire(); // background tick
    expect(worker.currentMode()).toBe("stalled");
    expect(reinforceCalls).toBe(0); // never drained
    expect(countOutbox(db, "pending")).toBe(1); // bundle retained, not lost
    expect(sched.lastMs()).toBe(15000); // backed off
    worker.stop();
  });

  test("STALLED: explicit tickNow() still drains (human intent overrides the gate)", async () => {
    const db = await freshDb();
    await enqueueCite(db, KEY_A, "s1");
    const detector = new ChainHealthDetector();
    detector._setModeForTest("stalled");

    const worker = startAnchorWorker({
      db,
      detector,
      sampleHealth: async () => ({ head: 815854, spread: 0 }),
      deps: okDeps(),
      setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => {},
    });

    const results = await worker.tickNow();
    expect(results.length).toBe(1);
    expect(results[0]?.ok).toBe(true);
    expect(countOutbox(db, "sent")).toBe(1);
    worker.stop();
  });

  test("HEALTHY: background tick drains normally (advancing head, tight spread)", async () => {
    const db = await freshDb();
    await enqueueCite(db, KEY_A, "s1");
    const sched = manualScheduler();
    // confirm=1, dwell=0 so a single advancing sample reaches HEALTHY.
    const detector = new ChainHealthDetector({ confirm: 1, dwellMs: 0 });
    detector.observe({ head: 844999, spread: 1 }); // prime lastHead so the next sample reads as "advanced"
    detector._setModeForTest("healthy");
    let nextHead = 845000;

    const worker = startAnchorWorker({
      db,
      detector,
      sampleHealth: async () => ({ head: nextHead++, spread: 1 }), // strictly advancing

      deps: okDeps(),
      idleMs: 3000,
      backoffMs: 15000,
      setTimer: sched.setTimer,
      clearTimer: sched.clearTimer,
    });

    await sched.fire();
    expect(worker.currentMode()).toBe("healthy");
    expect(countOutbox(db, "sent")).toBe(1);
    expect(sched.lastMs()).toBe(3000); // healthy success → idle cadence
    worker.stop();
  });
});
