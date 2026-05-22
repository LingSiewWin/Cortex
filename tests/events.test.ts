/**
 * Tests for src/lib/events.ts — the live spine domain event bus.
 *
 * Critical invariants:
 *   - publish/subscribe delivers in real time
 *   - replay returns chronological events for the requested types
 *   - ring buffer caps per type (memory bound)
 *   - sinceId resumes correctly (SSE reconnect path)
 *   - unsubscribe stops delivery
 *   - a throwing subscriber does not break the bus
 *   - _resetBus clears state between tests
 */

import { describe, test, expect, beforeEach } from "bun:test";
import type { Hex } from "@arkiv-network/sdk";
import {
  publish,
  subscribe,
  replay,
  bufferedTypes,
  currentSeq,
  _resetBus,
  ALL_EVENT_TYPES,
  type BufferedEvent,
  type DomainEvent,
  type DomainEventType,
} from "../src/lib/events";

const FAKE_HASH = "0x".padEnd(66, "a") as Hex;
const FAKE_ROOT = "0x".padEnd(66, "b") as Hex;
const FAKE_KEY = "0x".padEnd(66, "c") as Hex;

function rpcEvent(method: "getEntity" | "mutateEntities" = "getEntity"): DomainEvent {
  return {
    type: "arkiv.rpc.call",
    ts: Date.now(),
    method,
    byteSize: 256,
    ms: 12,
    ok: true,
  };
}

function rabitqEvent(): DomainEvent {
  return {
    type: "rabitq.encoded",
    ts: Date.now(),
    dim: 1536,
    bytes: 198,
    ratio: 31,
    ms: 8,
  };
}

function mmrEvent(leafIndex: number): DomainEvent {
  return {
    type: "mmr.appended",
    ts: Date.now(),
    leafIndex,
    leafHash: FAKE_HASH,
    newRoot: FAKE_ROOT,
    leafCount: leafIndex + 1,
  };
}

describe("events bus — publish + subscribe", () => {
  beforeEach(() => {
    _resetBus();
  });

  test("subscriber receives published events", () => {
    const received: BufferedEvent[] = [];
    const unsub = subscribe((e) => received.push(e));

    publish(rpcEvent());
    publish(rabitqEvent());

    expect(received.length).toBe(2);
    expect(received[0]!.type).toBe("arkiv.rpc.call");
    expect(received[1]!.type).toBe("rabitq.encoded");
    unsub();
  });

  test("publish returns envelope with monotonic id", () => {
    const a = publish(rpcEvent());
    const b = publish(rpcEvent());
    expect(Number(b.id)).toBeGreaterThan(Number(a.id));
  });

  test("subscriber only sees events published after subscribe", () => {
    publish(rpcEvent());
    const received: BufferedEvent[] = [];
    subscribe((e) => received.push(e));
    publish(rpcEvent());
    expect(received.length).toBe(1);
  });

  test("unsubscribe stops delivery", () => {
    const received: BufferedEvent[] = [];
    const unsub = subscribe((e) => received.push(e));
    publish(rpcEvent());
    unsub();
    publish(rpcEvent());
    expect(received.length).toBe(1);
  });

  test("multiple subscribers all receive events", () => {
    const a: BufferedEvent[] = [];
    const b: BufferedEvent[] = [];
    const c: BufferedEvent[] = [];
    subscribe((e) => a.push(e));
    subscribe((e) => b.push(e));
    subscribe((e) => c.push(e));
    publish(rpcEvent());
    expect(a.length).toBe(1);
    expect(b.length).toBe(1);
    expect(c.length).toBe(1);
  });

  test("throwing subscriber does not break the bus", () => {
    const good: BufferedEvent[] = [];
    subscribe(() => {
      throw new Error("boom");
    });
    subscribe((e) => good.push(e));
    // Should not throw out of publish even though one subscriber throws.
    expect(() => publish(rpcEvent())).not.toThrow();
    expect(good.length).toBe(1);
  });
});

describe("events bus — replay", () => {
  beforeEach(() => {
    _resetBus();
  });

  test("replay returns chronological events for requested types", () => {
    publish(rpcEvent("getEntity"));
    publish(rabitqEvent());
    publish(rpcEvent("mutateEntities"));
    publish(mmrEvent(0));

    const out = replay(["arkiv.rpc.call", "rabitq.encoded"]);
    expect(out.length).toBe(3);
    expect(out.map((e) => e.type)).toEqual([
      "arkiv.rpc.call",
      "rabitq.encoded",
      "arkiv.rpc.call",
    ]);
    // Ids ascending.
    for (let i = 1; i < out.length; i++) {
      expect(Number(out[i]!.id)).toBeGreaterThan(Number(out[i - 1]!.id));
    }
  });

  test("replay sinceId filters out older events", () => {
    const first = publish(rpcEvent());
    publish(rpcEvent());
    publish(rpcEvent());
    const out = replay(["arkiv.rpc.call"], first.id);
    // first.id is filtered out (strict >); we should see the 2 published after.
    expect(out.length).toBe(2);
  });

  test("replay perType caps each bucket independently", () => {
    for (let i = 0; i < 25; i++) publish(rpcEvent());
    for (let i = 0; i < 25; i++) publish(rabitqEvent());

    const out = replay(["arkiv.rpc.call", "rabitq.encoded"], undefined, 5);
    const rpcCount = out.filter((e) => e.type === "arkiv.rpc.call").length;
    const rabitqCount = out.filter((e) => e.type === "rabitq.encoded").length;
    expect(rpcCount).toBe(5);
    expect(rabitqCount).toBe(5);
  });

  test("replay with empty types returns []", () => {
    publish(rpcEvent());
    expect(replay([])).toEqual([]);
  });

  test("replay with NaN/negative sinceId is treated as 0 (defensive)", () => {
    publish(rpcEvent());
    publish(rpcEvent());
    expect(replay(["arkiv.rpc.call"], "not-a-number").length).toBe(2);
    expect(replay(["arkiv.rpc.call"], "-100").length).toBe(2);
  });

  test("replay for never-published type returns []", () => {
    publish(rpcEvent());
    expect(replay(["allowance.spent"])).toEqual([]);
  });
});

describe("events bus — ring buffer cap", () => {
  beforeEach(() => {
    _resetBus();
  });

  test("ring buffer caps at 200 per type", () => {
    for (let i = 0; i < 250; i++) publish(rpcEvent());
    const out = replay(["arkiv.rpc.call"], undefined, 1000);
    // Replay perType=1000 still bounded by ring cap of 200.
    expect(out.length).toBe(200);
  });

  test("different types do not share buffer", () => {
    for (let i = 0; i < 250; i++) publish(rpcEvent());
    for (let i = 0; i < 5; i++) publish(rabitqEvent());

    const rpcs = replay(["arkiv.rpc.call"], undefined, 1000);
    const rabitqs = replay(["rabitq.encoded"], undefined, 1000);
    expect(rpcs.length).toBe(200);
    expect(rabitqs.length).toBe(5);
  });

  test("after eviction, newest events remain in buffer", () => {
    for (let i = 0; i < 210; i++) publish(rpcEvent());
    const out = replay(["arkiv.rpc.call"], undefined, 1);
    // perType=1 returns the most recent. Its id should be the latest seq.
    expect(Number(out[0]!.id)).toBe(currentSeq());
  });
});

describe("events bus — bookkeeping", () => {
  beforeEach(() => {
    _resetBus();
  });

  test("bufferedTypes reports all types we've published", () => {
    publish(rpcEvent());
    publish(rabitqEvent());
    publish(mmrEvent(0));
    const types = bufferedTypes().sort();
    expect(types).toEqual(
      (["arkiv.rpc.call", "mmr.appended", "rabitq.encoded"] as DomainEventType[]).sort(),
    );
  });

  test("ALL_EVENT_TYPES covers the DomainEvent union (exhaustiveness guard)", () => {
    // Compile-time guard: this record MUST have a key for every event type.
    // Adding a new variant to DomainEvent without updating this record is a
    // TS error; the runtime assert then forces ALL_EVENT_TYPES to match too.
    const seen: Record<DomainEventType, true> = {
      "arkiv.rpc.call": true,
      "rabitq.encoded": true,
      "memory.created": true,
      "memory.cited": true,
      "mmr.appended": true,
      "anchor.committed": true,
      "allowance.spent": true,
      "agent.loop.tick": true,
      "recall.completed": true,
    };
    expect([...ALL_EVENT_TYPES].sort()).toEqual(
      (Object.keys(seen) as DomainEventType[]).sort(),
    );
    // No duplicates in the canonical list.
    expect(new Set(ALL_EVENT_TYPES).size).toBe(ALL_EVENT_TYPES.length);
  });

  test("_resetBus clears buffer and seq", () => {
    publish(rpcEvent());
    publish(rpcEvent());
    expect(currentSeq()).toBe(2);
    _resetBus();
    expect(currentSeq()).toBe(0);
    expect(bufferedTypes()).toEqual([]);
    expect(replay(["arkiv.rpc.call"])).toEqual([]);
  });

  test("memory.cited event with promotedTo is preserved through round-trip", () => {
    publish({
      type: "memory.cited",
      ts: 12345,
      entityKey: FAKE_KEY,
      reinforcementSeconds: 86400,
      promotedTo: "episodic",
    });
    const out = replay(["memory.cited"]);
    expect(out.length).toBe(1);
    const ev = out[0]!.event;
    if (ev.type !== "memory.cited") throw new Error("type narrowing failed");
    expect(ev.promotedTo).toBe("episodic");
    expect(ev.reinforcementSeconds).toBe(86400);
  });
});
