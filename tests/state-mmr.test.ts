/**
 * Cortex — state.ts (process-singleton MMR) tests.
 *
 * Guards the previously-untested MMR→anchor settlement path:
 *   - getStateMMR rebuilds leaves from SQLite in canonical (block, key) order,
 *     so a cold restart reproduces the SAME root (sovereignty: replayable).
 *   - leaves are ordered by created_at_block, NOT insertion order.
 *   - commitStateRoot is idempotent on root hash (UNIQUE — re-commit is a no-op).
 *   - appendToStateMMR rejects malformed hashes.
 *
 * Pure local SQLite — no Braga.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";
import { initMirrorDb, closeMirrorDb } from "../src/mirror/db";
import {
  getStateMMR,
  appendToStateMMR,
  commitStateRoot,
  resetStateMMRForTests,
} from "../src/mirror/state";
import { MMR } from "../src/mirror/mmr";
import type { Hex } from "viem";

let dbPath: string;

/** 64-hex (32-byte) value from a small int. */
function h(n: number): Hex {
  return ("0x" + n.toString(16).padStart(64, "0")) as Hex;
}
function bytes32(hex: Hex): Uint8Array {
  const clean = hex.slice(2);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function insertEntity(db: Database, key: Hex, block: number, payloadHash: Hex): void {
  db.prepare(
    "INSERT INTO entities (entity_key, owner, expires_at_block, created_at_block, " +
      "first_seen_block, last_event_block, last_event_type, state, payload_hash) " +
      "VALUES (?, ?, ?, ?, ?, ?, 'created', 'live', ?)",
  ).run(key, "0x" + "11".repeat(20), 999999, block, block, block, payloadHash);
}

beforeEach(async () => {
  dbPath = join(tmpdir(), `cortex-state-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  closeMirrorDb();
  resetStateMMRForTests();
  process.env.CORTEX_MIRROR_PATH = dbPath;
  await initMirrorDb(dbPath);
});

afterEach(() => {
  closeMirrorDb();
  resetStateMMRForTests();
  for (const s of ["", "-wal", "-shm"]) {
    try {
      if (existsSync(dbPath + s)) unlinkSync(dbPath + s);
    } catch {
      /* best effort */
    }
  }
  delete process.env.CORTEX_MIRROR_PATH;
});

test("getStateMMR rebuilds leaves in block order, deterministically across cold restarts", async () => {
  const db = await initMirrorDb();
  // Insert OUT of block order — the MMR must still order by created_at_block.
  insertEntity(db, h(0xcccc), 3, h(0xcc));
  insertEntity(db, h(0xaaaa), 1, h(0xaa));
  insertEntity(db, h(0xbbbb), 2, h(0xbb));

  resetStateMMRForTests();
  const root1 = (await getStateMMR()).getRootHex();

  // Cold-restart rebuild → identical root (replayability / sovereignty).
  resetStateMMRForTests();
  const mmr2 = await getStateMMR();
  expect(mmr2.getRootHex()).toBe(root1);
  expect(mmr2.size()).toBe(3);

  // Ground truth: appending AA, BB, CC in block order yields the same root.
  const expected = new MMR();
  for (const hh of [h(0xaa), h(0xbb), h(0xcc)]) expected.append(bytes32(hh));
  expect(root1).toBe(expected.getRootHex());
});

test("commitStateRoot is idempotent on the root hash", async () => {
  const db = await initMirrorDb();
  insertEntity(db, h(1), 1, h(0x11));
  resetStateMMRForTests();

  const a = await commitStateRoot("manual");
  const b = await commitStateRoot("act"); // same root (no new leaves) → no-op
  expect(b.id).toBe(a.id);
  const row = db
    .prepare("SELECT count(*) AS c FROM state_roots WHERE root_hex = ?")
    .get(a.rootHex) as { c: number };
  expect(row.c).toBe(1);
});

test("appendToStateMMR rejects a non-32-byte hash", async () => {
  resetStateMMRForTests();
  await expect(appendToStateMMR("0xdeadbeef" as Hex)).rejects.toThrow();
});

test("appendToStateMMR grows the root + leaf count", async () => {
  resetStateMMRForTests();
  const before = await getStateMMR();
  const sizeBefore = before.size();
  const r = await appendToStateMMR(h(0x42));
  expect(r.leafCount).toBe(sizeBefore + 1);
  expect(r.newRoot).toMatch(/^0x[0-9a-f]{64}$/);
});
