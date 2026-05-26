/**
 * Optimistic Memory Buffering — anchor worker tests (offline; no Braga).
 *
 * The worker is the single serialized writer that drains the outbox act() fills.
 * These tests inject the on-chain side effects (DrainDeps) so we exercise the
 * full sequence — extend → promote → write CITATION → MMR append → anchor →
 * reconcile — without touching the chain, and prove:
 *   - a successful drain records tx hashes + the citation key (status='sent')
 *     and flips the cited rows verified=1 under the anchored root
 *   - a bundle with no promotion skips the promote tx
 *   - a failed drain leaves the row pending (attempts++) for retry
 *   - drainOutbox is FIFO and stops at the first failure (outage backoff)
 */

import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import type { Hex } from "@arkiv-network/sdk";
import { act } from "../src/darwinian/citation.ts";
import {
  listPendingOutbox,
  countOutbox,
  type OutboxRow,
} from "../src/mirror/db.ts";
import {
  drainBundle,
  drainOutbox,
  type DrainDeps,
} from "../src/agent/anchor-worker.ts";
import { REINFORCEMENT } from "../src/constants.ts";

const FAKE_USER = "0xCAfeBABe00000000000000000000000000000000" as Hex;
const KEY_A = "0xaaaa111111111111111111111111111111111111111111111111111111111111" as Hex;
const KEY_B = "0xbbbb222222222222222222222222222222222222222222222222222222222222" as Hex;
const KEY_C = "0xcccc333333333333333333333333333333333333333333333333333333333333" as Hex;
const ROOT = ("0x" + "ab".repeat(32)) as Hex;
const CITE_ENTITY = ("0xc174" + "0".repeat(60)) as Hex;

const SCHEMA_PATH = new URL("../src/mirror/schema.sql", import.meta.url);

async function freshDb(): Promise<Database> {
  const db = new Database(":memory:");
  db.exec(await Bun.file(SCHEMA_PATH).text());
  return db;
}

/** Enqueue a real act_bundle via act() (also creates the citation_counts rows). */
async function enqueueCite(
  db: Database,
  key: Hex,
  sessionId: string,
  entityType: "observation" | "episode" = "observation",
): Promise<void> {
  await act({
    action: `cite ${sessionId}`,
    citations: [key],
    userPrimaryEOA: FAKE_USER,
    sessionId,
    _deps: {
      db,
      lastRecallIds: () => new Set([key]),
      entityTypeOf: () => entityType,
    },
  });
}

/** Enqueue a multi-citation act_bundle (one bundle citing several memories). */
async function enqueueMultiCite(
  db: Database,
  keys: Hex[],
  sessionId: string,
): Promise<void> {
  await act({
    action: `multi-cite ${sessionId}`,
    citations: keys,
    userPrimaryEOA: FAKE_USER,
    sessionId,
    _deps: {
      db,
      lastRecallIds: () => new Set(keys),
      entityTypeOf: () => "observation",
    },
  });
}

interface MockTracker {
  reinforceCalls: number;
  promoteCalls: { keys: readonly Hex[]; eoa: Hex }[];
  createCalls: number;
  anchorCalls: number;
}

function okDeps(t: MockTracker): DrainDeps {
  return {
    reinforce: async () => {
      t.reinforceCalls++;
      return "0xreinforce";
    },
    promote: async (keys, eoa) => {
      t.promoteCalls.push({ keys, eoa });
      return { txHash: "0xpromote" };
    },
    createCitation: async () => {
      t.createCalls++;
      return { entityKey: CITE_ENTITY, txHash: "0xcite" as Hex };
    },
    appendLeaf: async () => {},
    commitAnchor: async () => {
      t.anchorCalls++;
      return { rootHex: ROOT, txHash: "0xanchor" as Hex };
    },
  };
}

function tracker(): MockTracker {
  return { reinforceCalls: 0, promoteCalls: [], createCalls: 0, anchorCalls: 0 };
}

function onlyPending(db: Database): OutboxRow[] {
  return listPendingOutbox(db, 100);
}

function verifiedRow(db: Database, key: Hex): { verified: number; anchored_root: string | null } {
  return db
    .prepare("SELECT verified, anchored_root FROM citation_counts WHERE entity_key = ?")
    .get(key) as { verified: number; anchored_root: string | null };
}

describe("drainBundle — success", () => {
  test("single cite (no promotion): extend → create → anchor, reconciled", async () => {
    const db = await freshDb();
    await enqueueCite(db, KEY_A, "s1");
    const row = onlyPending(db)[0]!;
    const t = tracker();

    const result = await drainBundle(db, row, okDeps(t));

    expect(result.ok).toBe(true);
    expect(result.citationEntityKey).toBe(CITE_ENTITY);
    expect(result.rootHex).toBe(ROOT);
    // No promotion on a first cite → promote skipped.
    expect(t.reinforceCalls).toBe(1);
    expect(t.promoteCalls.length).toBe(0);
    expect(t.createCalls).toBe(1);
    expect(t.anchorCalls).toBe(1);
    expect(result.txHashes).toEqual(["0xreinforce", "0xcite", "0xanchor"]);

    // Outbox row reconciled.
    expect(countOutbox(db, "pending")).toBe(0);
    expect(countOutbox(db, "sent")).toBe(1);
    // Cited memory flipped verified under the anchored root.
    const v = verifiedRow(db, KEY_A);
    expect(v.verified).toBe(1);
    expect(v.anchored_root).toBe(ROOT);
  });

  test("bundle with a promotion fires the ownership transfer", async () => {
    const db = await freshDb();
    // Two cites cross promoteToEpisodic (threshold 2) → 2nd bundle promotes.
    await enqueueCite(db, KEY_A, "s1");
    await enqueueCite(db, KEY_A, "s2");
    const pending = onlyPending(db);
    expect(pending.length).toBe(2);
    const promotingRow = pending[1]!; // the 2nd act carries the promotion
    expect(promotingRow.bundle.promotionsToEpisode).toEqual([KEY_A]);
    const t = tracker();

    const result = await drainBundle(db, promotingRow, okDeps(t));

    expect(result.ok).toBe(true);
    expect(t.promoteCalls.length).toBe(1);
    expect(t.promoteCalls[0]?.keys).toEqual([KEY_A]);
    expect(t.promoteCalls[0]?.eoa).toBe(FAKE_USER);
    expect(result.txHashes).toEqual(["0xreinforce", "0xpromote", "0xcite", "0xanchor"]);
  });
});

describe("drainBundle — failure", () => {
  test("createCitation throws → row stays pending, attempts++, not verified", async () => {
    const db = await freshDb();
    await enqueueCite(db, KEY_A, "s1");
    const row = onlyPending(db)[0]!;

    const result = await drainBundle(db, row, {
      reinforce: async () => "0xreinforce",
      createCitation: async () => {
        throw new Error("braga down: head frozen");
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("braga down");
    expect(result.citationEntityKey).toBeNull();
    // Stays pending for retry; attempts bumped.
    expect(countOutbox(db, "pending")).toBe(1);
    expect(onlyPending(db)[0]?.attempts).toBe(1);
    // Not verified — the anchor never landed.
    expect(verifiedRow(db, KEY_A).verified).toBe(0);
  });
});

describe("drainOutbox — FIFO + outage backoff", () => {
  test("drains all pending oldest-first when every bundle succeeds", async () => {
    const db = await freshDb();
    await enqueueCite(db, KEY_A, "s1");
    await enqueueCite(db, KEY_A, "s2");
    await enqueueCite(db, KEY_A, "s3");
    const t = tracker();

    const results = await drainOutbox(db, okDeps(t));

    expect(results.length).toBe(3);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(countOutbox(db, "pending")).toBe(0);
    expect(countOutbox(db, "sent")).toBe(3);
  });

  test("stops at the first failure — later bundles stay pending", async () => {
    const db = await freshDb();
    await enqueueCite(db, KEY_A, "s1");
    await enqueueCite(db, KEY_A, "s2");
    await enqueueCite(db, KEY_A, "s3");

    // Always fail (simulates Braga being down for the whole pass).
    const results = await drainOutbox(db, {
      reinforce: async () => {
        throw new Error("braga down");
      },
    });

    // Only the first bundle was attempted before we backed off.
    expect(results.length).toBe(1);
    expect(results[0]?.ok).toBe(false);
    // Nothing anchored — all three still pending.
    expect(countOutbox(db, "pending")).toBe(3);
    expect(countOutbox(db, "sent")).toBe(0);
  });
});

describe("threshold sanity", () => {
  test("promoteToEpisodic is the assumed value (2) for these tests", () => {
    expect(REINFORCEMENT.promoteToEpisodic).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Gap: retry / resume after a transient failure (at-least-once semantics).
// The existing failure test only proves ONE failed attempt leaves the row
// pending. These prove the bundle is actually re-attempted on the NEXT pass and
// can succeed — without being drained twice or silently dropped.
// ---------------------------------------------------------------------------
describe("drainBundle — retry resumes a previously-failed bundle", () => {
  test("fail then succeed: attempts=1 after fail, drains clean on retry, verified once", async () => {
    const db = await freshDb();
    await enqueueCite(db, KEY_A, "s1");

    // Pass 1: createCitation throws (Braga briefly down).
    const row1 = onlyPending(db)[0]!;
    const fail = await drainBundle(db, row1, {
      reinforce: async () => "0xreinforce",
      createCitation: async () => {
        throw new Error("braga down: head frozen");
      },
    });
    expect(fail.ok).toBe(false);
    expect(countOutbox(db, "pending")).toBe(1);
    expect(onlyPending(db)[0]?.attempts).toBe(1);
    expect(verifiedRow(db, KEY_A).verified).toBe(0);

    // Pass 2: Braga recovers. The SAME bundle is re-listed (still pending) and
    // now drains clean. attempts persists from the failed pass (the worker does
    // not reset it), proving the row was resumed, not freshly enqueued.
    const row2 = onlyPending(db)[0]!;
    expect(row2.id).toBe(row1.id);
    expect(row2.attempts).toBe(1);
    const t = tracker();
    const ok = await drainBundle(db, row2, okDeps(t));

    expect(ok.ok).toBe(true);
    expect(countOutbox(db, "pending")).toBe(0);
    expect(countOutbox(db, "sent")).toBe(1);
    // Exactly one anchor fired on the successful pass (no double from the retry).
    expect(t.anchorCalls).toBe(1);
    const v = verifiedRow(db, KEY_A);
    expect(v.verified).toBe(1);
    expect(v.anchored_root).toBe(ROOT);
  });

  test("a 'sent' bundle is no longer listed as pending (not drained twice)", async () => {
    const db = await freshDb();
    await enqueueCite(db, KEY_A, "s1");
    const row = onlyPending(db)[0]!;

    await drainBundle(db, row, okDeps(tracker()));
    expect(countOutbox(db, "sent")).toBe(1);

    // listPendingOutbox filters status='sent' out → a second drainOutbox is a
    // no-op (the row can never be re-attempted once anchored).
    const second = await drainOutbox(db, okDeps(tracker()));
    expect(second.length).toBe(0);
    expect(countOutbox(db, "sent")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Gap: partial failure mid-bundle. extend lands on-chain, then create reverts.
// Per the worker docstring this is at-least-once: the row stays pending and the
// whole bundle is retried. We assert the partial txHashes are NOT persisted as
// 'sent' and the memory is NOT marked verified (the anchor never landed).
// ---------------------------------------------------------------------------
describe("drainBundle — partial failure (extend ok, create fails)", () => {
  test("extend succeeds then create throws → row pending, unverified, no sent state", async () => {
    const db = await freshDb();
    await enqueueCite(db, KEY_A, "s1");
    const row = onlyPending(db)[0]!;

    let reinforceCalls = 0;
    let anchorCalls = 0;
    const result = await drainBundle(db, row, {
      reinforce: async () => {
        reinforceCalls++;
        return "0xreinforce-landed";
      },
      createCitation: async () => {
        throw new Error("create reverted: nonce too low");
      },
      commitAnchor: async () => {
        anchorCalls++;
        return { rootHex: ROOT, txHash: "0xanchor" as Hex };
      },
    });

    expect(result.ok).toBe(false);
    // extend DID run (its tx landed on-chain) but we never reached the anchor.
    expect(reinforceCalls).toBe(1);
    expect(anchorCalls).toBe(0);
    // The partial extend tx is reported on the result for observability, but the
    // row is NOT marked sent and carries no persisted tx hashes.
    expect(result.txHashes).toEqual(["0xreinforce-landed"]);
    const pending = onlyPending(db)[0]!;
    expect(pending.status).toBe("pending");
    expect(pending.sentTxHashes).toBeNull();
    expect(pending.attempts).toBe(1);
    // Not verified — the anchor never landed.
    expect(verifiedRow(db, KEY_A).verified).toBe(0);
    expect(verifiedRow(db, KEY_A).anchored_root).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Gap: multi-citation bundle. One bundle citing several memories must extend +
// verify EVERY cited key, and verification must be precise — an uncited memory
// row stays verified=0.
// ---------------------------------------------------------------------------
describe("drainBundle — multi-citation bundle", () => {
  test("verifies every cited key under the anchored root; leaves uncited rows alone", async () => {
    const db = await freshDb();
    // One bundle cites A and B. C is cited in a SEPARATE earlier bundle so it has
    // a citation_counts row but is NOT part of the bundle we drain.
    await enqueueCite(db, KEY_C, "s0"); // C: its own pending bundle (left alone)
    await enqueueMultiCite(db, [KEY_A, KEY_B], "s1");

    // Drain only the multi-cite bundle (the last enqueued).
    const pending = onlyPending(db);
    const multi = pending[pending.length - 1]!;
    expect(multi.bundle.citations.sort()).toEqual([KEY_A, KEY_B].sort());
    expect(multi.bundle.reinforceItems.length).toBe(2);

    const t = tracker();
    const result = await drainBundle(db, multi, okDeps(t));

    expect(result.ok).toBe(true);
    // A single reinforce batch + single create + single anchor for the bundle.
    expect(t.reinforceCalls).toBe(1);
    expect(t.createCalls).toBe(1);
    expect(t.anchorCalls).toBe(1);
    // Both cited keys flipped verified under the same root.
    for (const k of [KEY_A, KEY_B]) {
      const v = verifiedRow(db, k);
      expect(v.verified).toBe(1);
      expect(v.anchored_root).toBe(ROOT);
    }
    // The uncited memory C is untouched by markVerified.
    const cRow = verifiedRow(db, KEY_C);
    expect(cRow.verified).toBe(0);
    expect(cRow.anchored_root).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Gap: setPayloadHash side effect. The worker writes the citation entity's
// payload_hash so a cold restart rebuilds the same MMR leaf. Assert the entity
// row carries the exact hash act() committed to the bundle.
// ---------------------------------------------------------------------------
describe("drainBundle — persists the citation entity payload hash", () => {
  test("entities row for the citation key gets the bundle's payload hash", async () => {
    const db = await freshDb();
    await enqueueCite(db, KEY_A, "s1");
    const row = onlyPending(db)[0]!;
    const expectedHash = row.bundle.citationPayloadHashHex;

    // The citation entity does not exist in `entities` yet; seed a row so the
    // UPDATE in setPayloadHash has a target (mirrors the daemon having observed
    // the create event by the time the worker writes the hash).
    db.prepare(
      "INSERT INTO entities (entity_key, owner, expires_at_block, first_seen_block, last_event_block, last_event_type) " +
        "VALUES (?, ?, 0, 0, 0, 'created')",
    ).run(CITE_ENTITY, FAKE_USER);

    await drainBundle(db, row, okDeps(tracker()));

    const stored = db
      .prepare("SELECT payload_hash FROM entities WHERE entity_key = ?")
      .get(CITE_ENTITY) as { payload_hash: string | null };
    expect(stored.payload_hash).toBe(expectedHash);
  });
});

// ---------------------------------------------------------------------------
// Gap: FIFO ordering under interleaved enqueue + a mid-queue success boundary.
// listPendingOutbox is ORDER BY id ASC; prove drainOutbox processes in act
// order and that distinct anchored roots land on the right bundles.
// ---------------------------------------------------------------------------
describe("drainOutbox — FIFO order under interleaved enqueue", () => {
  test("bundles drain oldest-first regardless of which memory they cite", async () => {
    const db = await freshDb();
    // Interleave citations across different memories.
    await enqueueCite(db, KEY_A, "s1");
    await enqueueCite(db, KEY_B, "s1");
    await enqueueCite(db, KEY_A, "s2");

    const drainedActions: string[] = [];
    const t = tracker();
    const okBase = okDeps(t);
    const results = await drainOutbox(db, {
      ...okBase,
      createCitation: async (input) => {
        const a = input.attributes.find((x) => x.key === "action");
        drainedActions.push(String(a?.value));
        return { entityKey: CITE_ENTITY, txHash: "0xcite" as Hex };
      },
    });

    expect(results.length).toBe(3);
    expect(results.every((r) => r.ok)).toBe(true);
    // Drained strictly in enqueue order.
    expect(drainedActions).toEqual(["cite s1", "cite s1", "cite s2"]);
    // Result ids are ascending (FIFO).
    const ids = results.map((r) => r.outboxId);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  test("a later failure leaves earlier-sent bundles sent and the rest pending", async () => {
    const db = await freshDb();
    await enqueueCite(db, KEY_A, "s1");
    await enqueueCite(db, KEY_A, "s2");
    await enqueueCite(db, KEY_A, "s3");

    // Succeed on the first bundle, fail on the second (stops the pass there).
    let createCount = 0;
    const results = await drainOutbox(db, {
      reinforce: async () => "0xreinforce",
      createCitation: async () => {
        createCount++;
        if (createCount === 2) throw new Error("braga down mid-pass");
        return { entityKey: CITE_ENTITY, txHash: "0xcite" as Hex };
      },
      appendLeaf: async () => {},
      commitAnchor: async () => ({ rootHex: ROOT, txHash: "0xanchor" as Hex }),
    });

    // Two attempted: first ok, second failed → stop.
    expect(results.length).toBe(2);
    expect(results[0]?.ok).toBe(true);
    expect(results[1]?.ok).toBe(false);
    // 1 anchored, 2 still pending (the failed one + the untouched third).
    expect(countOutbox(db, "sent")).toBe(1);
    expect(countOutbox(db, "pending")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Gap: drainBundle with an empty reinforce list skips the extend tx. act()
// never produces this (a queued bundle always has ≥1 reinforce item), but the
// worker guards `if (b.reinforceItems.length > 0)`, so an empty bundle (e.g. a
// future bundle kind, or a hand-built one) must still anchor without an extend.
// ---------------------------------------------------------------------------
describe("drainBundle — empty reinforce list", () => {
  test("a bundle with no reinforce items skips extend but still creates + anchors", async () => {
    const db = await freshDb();
    await enqueueCite(db, KEY_A, "s1");
    const base = onlyPending(db)[0]!;
    // Hand-build a row with no reinforce items + no promotions.
    const row: OutboxRow = {
      ...base,
      bundle: { ...base.bundle, reinforceItems: [], promotionsToEpisode: [] },
    };

    const t = tracker();
    const result = await drainBundle(db, row, okDeps(t));

    expect(result.ok).toBe(true);
    expect(t.reinforceCalls).toBe(0); // skipped — nothing to extend
    expect(t.promoteCalls.length).toBe(0);
    expect(t.createCalls).toBe(1);
    expect(t.anchorCalls).toBe(1);
    // Only the create + anchor tx hashes (no reinforce hash).
    expect(result.txHashes).toEqual(["0xcite", "0xanchor"]);
  });
});
