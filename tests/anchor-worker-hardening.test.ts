/**
 * Optimistic Memory Buffering — hardening tests (offline; no Braga).
 *
 * Covers the fixes for issues surfaced by the design + code review:
 *   - MMR append is idempotent (state.ts dedup) → a citation leaf appended by the
 *     worker and later re-observed by the daemon (or re-appended on a bundle retry)
 *     lands ONCE, so the live root can't diverge by double-counting.
 *   - dead-letter cap → a permanently-failing bundle transitions to status='failed'
 *     after MAX_ATTEMPTS instead of retrying forever + head-of-line-blocking the queue.
 */

import { test, expect, describe, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hex } from "@arkiv-network/sdk";
import { act } from "../src/darwinian/citation.ts";
import { closeMirrorDb, initMirrorDb, countOutbox, listPendingOutbox } from "../src/mirror/db.ts";
import { drainOutbox } from "../src/agent/anchor-worker.ts";
import { appendToStateMMR, resetStateMMRForTests } from "../src/mirror/state.ts";

const KEY_A = "0xaaaa111111111111111111111111111111111111111111111111111111111111" as Hex;
const FAKE_USER = "0xCAfeBABe00000000000000000000000000000000" as Hex;
const SCHEMA_PATH = new URL("../src/mirror/schema.sql", import.meta.url);

async function freshDb(): Promise<Database> {
  const db = new Database(":memory:");
  db.exec(await Bun.file(SCHEMA_PATH).text());
  return db;
}

describe("MMR append idempotency (state.ts dedup)", () => {
  afterEach(() => {
    closeMirrorDb();
    resetStateMMRForTests();
    delete process.env.CORTEX_MIRROR_PATH;
  });

  test("re-appending the same leaf hash is a no-op (worker + daemon can't double-count)", async () => {
    process.env.CORTEX_MIRROR_PATH = join(tmpdir(), `mmr-dedup-${Date.now()}.sqlite`);
    closeMirrorDb();
    resetStateMMRForTests();
    await initMirrorDb(process.env.CORTEX_MIRROR_PATH);

    const leaf = ("0x" + "ab".repeat(32)) as Hex;
    const first = await appendToStateMMR(leaf);
    expect(first.deduped).toBeUndefined();
    expect(first.leafCount).toBe(1);

    // Worker appended it; now the daemon re-observes the same CITATION entity.
    const second = await appendToStateMMR(leaf);
    expect(second.deduped).toBe(true);
    expect(second.leafCount).toBe(1); // unchanged — not double-counted
    expect(second.newRoot).toBe(first.newRoot); // root identical

    // A genuinely new leaf still appends.
    const third = await appendToStateMMR(("0x" + "cd".repeat(32)) as Hex);
    expect(third.deduped).toBeUndefined();
    expect(third.leafCount).toBe(2);
  });
});

describe("dead-letter cap (anchor-worker)", () => {
  test("a permanently-failing bundle becomes status='failed' and stops blocking the queue", async () => {
    const db = await freshDb();
    await act({
      action: "poison bundle",
      citations: [KEY_A],
      userPrimaryEOA: FAKE_USER,
      sessionId: "s1",
      _deps: { db, lastRecallIds: () => new Set([KEY_A]), entityTypeOf: () => "observation" },
    });
    expect(countOutbox(db, "pending")).toBe(1);

    // Always-failing deps — simulate a permanently-rejecting entity.
    const failingDeps = {
      reinforce: async () => {
        throw new Error("precompile rejects this entity permanently");
      },
    };

    // Drain repeatedly. Each pass = one attempt; after MAX_ATTEMPTS it dead-letters.
    let passes = 0;
    while (countOutbox(db, "pending") > 0 && passes < 20) {
      await drainOutbox(db, failingDeps);
      passes++;
    }

    expect(countOutbox(db, "pending")).toBe(0); // no longer blocks the queue
    expect(countOutbox(db, "failed")).toBe(1); // dead-lettered, surfaced
    expect(passes).toBeLessThanOrEqual(8); // capped, not retried forever
    expect(passes).toBeGreaterThan(1); // but it DID retry before giving up
  });

  test("dead-lettered bundle is skipped so later bundles still drain", async () => {
    const db = await freshDb();
    const KEY_B = "0xbbbb222222222222222222222222222222222222222222222222222222222222" as Hex;
    // Bundle #1 cites KEY_A (will be poisoned), #2 cites KEY_B (would succeed).
    for (const [k, s] of [[KEY_A, "s1"], [KEY_B, "s2"]] as const) {
      await act({
        action: `cite ${s}`,
        citations: [k],
        userPrimaryEOA: FAKE_USER,
        sessionId: s,
        _deps: { db, lastRecallIds: () => new Set([k]), entityTypeOf: () => "observation" },
      });
    }
    expect(countOutbox(db, "pending")).toBe(2);

    // reinforce fails ONLY for KEY_A's bundle; KEY_B's bundle anchors fine.
    let nonce = 0;
    const deps = {
      reinforce: async (items: { entityKey: Hex; reinforcementSeconds: number }[]) => {
        if (items.some((i) => i.entityKey === KEY_A)) throw new Error("KEY_A poisoned");
        return "0xreinforce" + nonce++;
      },
      promote: async () => ({ txHash: "0xpromote" }),
      createCitation: async () => ({ entityKey: ("0xc174" + "0".repeat(60)) as Hex, txHash: "0xcite" as Hex }),
      appendLeaf: async () => {},
      commitAnchor: async () => ({ rootHex: ("0x" + "ee".repeat(32)) as Hex, txHash: "0xanchor" as Hex }),
    };

    let passes = 0;
    while (countOutbox(db, "pending") > 0 && passes < 20) {
      await drainOutbox(db, deps);
      passes++;
    }

    // KEY_A dead-lettered; KEY_B successfully anchored — the poison didn't block it.
    expect(countOutbox(db, "failed")).toBe(1);
    expect(countOutbox(db, "sent")).toBe(1);
    expect(countOutbox(db, "pending")).toBe(0);
    const dead = listPendingOutbox(db, 10); // none pending
    expect(dead.length).toBe(0);
  });
});
