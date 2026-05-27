/**
 * Cortex — evict-watcher unit tests.
 *
 * Proves the watcher emits `memory.evicted` exactly once when a live mirrored
 * memory crosses its expires_at_block, seeds the historical graveyard so it
 * doesn't replay old expiries as fresh drops, and carries the right tier.
 *
 * All deps are injected (db, currentBlock, publish, timer) so the test is
 * deterministic — sweep() is driven manually, the scheduler is a no-op.
 */

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { startEvictWatcher } from "../src/mirror/evict-watcher.ts";
import type { DomainEvent } from "../src/lib/events.ts";

/** Minimal entities table — only the columns the watcher reads. */
function makeDb(): Database {
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE entities (entity_key TEXT PRIMARY KEY, expires_at_block INTEGER NOT NULL, " +
      "attributes_json TEXT, state TEXT NOT NULL DEFAULT 'live');",
  );
  return db;
}

function insert(db: Database, key: string, expiresAt: number, state = "live", tier?: string) {
  const attrs = tier ? JSON.stringify([{ key: "entityType", value: tier }]) : null;
  db.prepare(
    "INSERT INTO entities (entity_key, expires_at_block, attributes_json, state) VALUES (?, ?, ?, ?)",
  ).run(key, expiresAt, attrs, state);
}

const noopTimer = () => 0 as unknown as ReturnType<typeof setTimeout>;

test("emits memory.evicted when a live memory crosses expiry", async () => {
  const db = makeDb();
  // Live memory expiring at block 100.
  insert(db, "0xaaa", 100, "live", "observation");
  let block = 90; // not yet expired at start

  const events: DomainEvent[] = [];
  const watcher = await startEvictWatcher({
    deps: {
      db,
      currentBlock: async () => block,
      publish: (e) => events.push(e),
      setTimer: noopTimer,
      clearTimer: () => {},
      now: () => 42,
    },
  });

  // Block 90: nothing expired yet.
  expect(await watcher.sweep()).toBe(0);
  expect(events.length).toBe(0);

  // Advance past the lease → one eviction fires.
  block = 105;
  expect(await watcher.sweep()).toBe(1);
  expect(events.length).toBe(1);
  const ev = events[0]!;
  expect(ev.type).toBe("memory.evicted");
  if (ev.type === "memory.evicted") {
    expect(ev.entityKey).toBe("0xaaa");
    // observation entityType maps to the "working" spine tier zone.
    expect(ev.tier).toBe("working");
    expect(ev.expiredAtBlock).toBe(100);
    expect(ev.gasReclaimedEstimate).toBeGreaterThan(0);
  }

  // Idempotent: a second sweep does not re-fire for the same entity.
  expect(await watcher.sweep()).toBe(0);
  expect(events.length).toBe(1);

  watcher.stop();
});

test("seeds the historical graveyard — does not replay already-expired memories", async () => {
  const db = makeDb();
  // Already expired before the watcher starts (block already past its lease).
  insert(db, "0xold", 50, "live", "episode");
  insert(db, "0xdead", 10, "expired", "rule");
  const block = 100;

  const events: DomainEvent[] = [];
  const watcher = await startEvictWatcher({
    deps: {
      db,
      currentBlock: async () => block,
      publish: (e) => events.push(e),
      setTimer: noopTimer,
      clearTimer: () => {},
    },
  });

  // First sweep: both are historical → seeded, nothing emitted.
  expect(await watcher.sweep()).toBe(0);
  expect(events.length).toBe(0);
  watcher.stop();
});

test("maps stamped entityType to the spine tier", async () => {
  const db = makeDb();
  insert(db, "0xep", 100, "live", "episode");
  let block = 90;
  const events: DomainEvent[] = [];
  const watcher = await startEvictWatcher({
    deps: {
      db,
      currentBlock: async () => block,
      publish: (e) => events.push(e),
      setTimer: noopTimer,
      clearTimer: () => {},
    },
  });
  block = 101;
  await watcher.sweep();
  const ev = events.find((e) => e.type === "memory.evicted");
  expect(ev && ev.type === "memory.evicted" && ev.tier).toBe("episodic");
  watcher.stop();
});
