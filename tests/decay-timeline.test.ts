/**
 * Decay Receipt timeline builder — pure-function tests (no DB, no chain).
 *
 * Asserts the lease step-curve is derived correctly from the event log, the
 * committed-local "queued" overlay and the synthetic neglect downslope are
 * appended honestly, and an evicted memory terminates at zero with no synthetic
 * tail.
 */

import { test, expect, describe } from "bun:test";
import { buildDecayTimeline } from "../src/server/decay-timeline.ts";

const KEY = "0xabc0000000000000000000000000000000000000000000000000000000000abc";
const BT = 2; // BRAGA.blockTimeSeconds
const NOW = 1_000_000;

function ev(over: Partial<Parameters<typeof buildDecayTimeline>[0]["events"][number]>) {
  return {
    event_type: "created" as const,
    block_number: 0,
    old_expiration_block: null,
    new_expiration_block: null,
    tx_hash: null,
    observed_at_ms: 0,
    ...over,
  };
}

describe("buildDecayTimeline", () => {
  test("created → onchain lease point + synthetic downslope, estimated", () => {
    const t = buildDecayTimeline({
      entityKey: KEY,
      events: [ev({ event_type: "created", block_number: 1000, new_expiration_block: 2800, observed_at_ms: 100, tx_hash: "0xdead" })],
      pendingSeconds: 0,
      blockTimeSeconds: BT,
      nowMs: NOW,
    });
    expect(t.cortexId).toBe(`cortex://${KEY}`);
    expect(t.state).toBe("live");
    // (2800-1000)*2 = 3600s lease at creation.
    expect(t.points[0]!.leaseSeconds).toBe(3600);
    expect(t.points[0]!.source).toBe("onchain");
    // synthetic neglect downslope appended, terminating at 0.
    const tail = t.points[t.points.length - 1]!;
    expect(tail.source).toBe("synthetic");
    expect(tail.leaseSeconds).toBe(0);
    expect(t.estimated).toBe(true);
  });

  test("extended event steps the lease up (gain from old→new)", () => {
    const t = buildDecayTimeline({
      entityKey: KEY,
      events: [
        ev({ event_type: "created", block_number: 1000, new_expiration_block: 2800, observed_at_ms: 100 }),
        ev({ event_type: "extended", block_number: 1100, old_expiration_block: 2800, new_expiration_block: 46000, observed_at_ms: 200, tx_hash: "0xbeef" }),
      ],
      pendingSeconds: 0,
      blockTimeSeconds: BT,
      nowMs: NOW,
    });
    const extended = t.points.find((p) => p.eventType === "extended")!;
    // lease at extend = (46000-1100)*2 = 89800; gain = (46000-2800)*2 = 86400.
    expect(extended.leaseSeconds).toBe(89800);
    expect(extended.label).toContain("+~1.0d"); // 86400s ≈ 1.0d
    expect(extended.txHash).toBe("0xbeef");
  });

  test("pending committed-local cites → one projected 'queued' step before the downslope", () => {
    const t = buildDecayTimeline({
      entityKey: KEY,
      events: [ev({ event_type: "created", block_number: 1000, new_expiration_block: 2800, observed_at_ms: 100 })],
      pendingSeconds: 86_400,
      blockTimeSeconds: BT,
      nowMs: NOW,
    });
    const queued = t.points.find((p) => p.eventType === "queued")!;
    expect(queued.source).toBe("projected");
    // base lease (3600) + pending (86400).
    expect(queued.leaseSeconds).toBe(3600 + 86_400);
    expect(queued.txHash).toBeNull();
    // synthetic downslope still terminates the curve.
    expect(t.points[t.points.length - 1]!.source).toBe("synthetic");
  });

  test("evicted memory terminates at 0 with NO synthetic tail", () => {
    const t = buildDecayTimeline({
      entityKey: KEY,
      events: [
        ev({ event_type: "created", block_number: 1000, new_expiration_block: 2800, observed_at_ms: 100 }),
        ev({ event_type: "expired", block_number: 2801, observed_at_ms: 300 }),
      ],
      pendingSeconds: 0,
      blockTimeSeconds: BT,
      nowMs: NOW,
    });
    expect(t.state).toBe("expired");
    const tail = t.points[t.points.length - 1]!;
    expect(tail.eventType).toBe("evicted");
    expect(tail.leaseSeconds).toBe(0);
    expect(t.points.some((p) => p.source === "synthetic")).toBe(false);
  });

  test("no events and no pending → empty curve, unknown state, honest note", () => {
    const t = buildDecayTimeline({
      entityKey: KEY,
      events: [],
      pendingSeconds: 0,
      blockTimeSeconds: BT,
      nowMs: NOW,
    });
    expect(t.points).toHaveLength(0);
    expect(t.state).toBe("unknown");
    expect(t.note).toContain("No events");
  });

  test("cited before create anchored (events empty, pending>0) → state 'queued', not 'unknown'", () => {
    // The optimistic-act() live demo path: header must not claim 'unknown'/'no data'
    // while a populated curve renders below it (verify-debate MUST-FIX #2).
    const t = buildDecayTimeline({
      entityKey: KEY,
      events: [],
      pendingSeconds: 86_400,
      blockTimeSeconds: BT,
      nowMs: NOW,
    });
    expect(t.state).toBe("queued");
    expect(t.note).toContain("Committed locally");
    expect(t.points.find((p) => p.eventType === "queued")?.leaseSeconds).toBe(86_400);
    expect(t.points[t.points.length - 1]!.source).toBe("synthetic");
  });
});
