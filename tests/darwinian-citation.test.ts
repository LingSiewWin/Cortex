/**
 * Phase 5 / Optimistic Memory Buffering — act() / citation tracker tests.
 *
 * act() is now OPTIMISTIC: it commits all scoring to the local SQLite mirror and
 * enqueues the on-chain work to the `outbox` (drained later by the anchor
 * worker — see tests/anchor-worker.test.ts). So these tests assert the local
 * effects + the enqueued bundle, NOT synchronous tx hashes:
 *   1. Citations not in the last recall set are silently dropped
 *      (hallucination defense). Their counts never bump, nothing is enqueued.
 *   2. Valid citations bump the count, evolve the weight, and enqueue exactly
 *      one act_bundle carrying the reinforce items + CITATION payload.
 *   3. Crossing promoteToEpisodic marks promoted_to='episode' locally AND puts
 *      the key in bundle.promotionsToEpisode (the worker does the ownership tx).
 *   4. Crossing promoteToSemantic + distinctSessionsForSemantic flags
 *      promoted_to='rule' for the distillation cron.
 *
 * The mirror DB is dependency-injected (in-memory sqlite) so tests don't touch
 * the dev mirror or Braga.
 */

import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import type { Hex } from "@arkiv-network/sdk";
import { act, getCitationStats } from "../src/darwinian/citation.ts";
import { listPendingOutbox, countOutbox, type OutboxBundle } from "../src/mirror/db.ts";
import { ENTITY_TYPE, REINFORCEMENT } from "../src/constants.ts";

const FAKE_USER = "0xCAfeBABe00000000000000000000000000000000" as Hex;
const KEY_A = "0xaaaa111111111111111111111111111111111111111111111111111111111111" as Hex;
const KEY_B = "0xbbbb222222222222222222222222222222222222222222222222222222222222" as Hex;
const KEY_C = "0xcccc333333333333333333333333333333333333333333333333333333333333" as Hex;
const HALLUCINATED = "0xdeadbeef0000000000000000000000000000000000000000000000000000dead" as Hex;

const SCHEMA_PATH = new URL("../src/mirror/schema.sql", import.meta.url);

/** Build a fresh in-memory mirror DB with the project schema applied. */
async function freshDb(): Promise<Database> {
  const db = new Database(":memory:");
  const ddl = await Bun.file(SCHEMA_PATH).text();
  db.exec(ddl);
  return db;
}

interface ScenarioDeps {
  db: Database;
  lastRecallIds: Set<Hex>;
  entityTypes: Map<Hex, "observation" | "episode" | "rule">;
}

function makeDeps(db: Database, lastIds: Hex[]): ScenarioDeps {
  return {
    db,
    lastRecallIds: new Set(lastIds),
    entityTypes: new Map(),
  };
}

/** ActDeps wired to the scenario — act() now only needs db + recall set + types. */
function depBundle(s: ScenarioDeps) {
  return {
    db: s.db,
    lastRecallIds: () => s.lastRecallIds,
    entityTypeOf: (k: Hex) => s.entityTypes.get(k),
  };
}

/** The most recently enqueued act_bundle (highest outbox id), or null. */
function latestBundle(db: Database): OutboxBundle | null {
  const pending = listPendingOutbox(db, 100);
  return pending.length > 0 ? pending[pending.length - 1]!.bundle : null;
}

describe("act — hallucination defense", () => {
  test("citations not in the last recall set are silently dropped", async () => {
    const db = await freshDb();
    const deps = makeDeps(db, [KEY_A]); // KEY_B and HALLUCINATED are NOT allowed
    deps.entityTypes.set(KEY_A, "observation");

    const result = await act({
      action: "test action",
      citations: [KEY_A, KEY_B, HALLUCINATED],
      userPrimaryEOA: FAKE_USER,
      _deps: depBundle(deps),
    });

    expect(result.citations).toEqual([KEY_A]);
    expect(result.extendedKeys).toEqual([KEY_A]);
    // The hallucinated keys must not have rows in citation_counts.
    expect(await getCitationStats(KEY_B, db)).toBeNull();
    expect(await getCitationStats(HALLUCINATED, db)).toBeNull();
    // The valid citation got counted.
    const stats = await getCitationStats(KEY_A, db);
    expect(stats?.count).toBe(1);
    // Exactly one bundle enqueued, citing only the valid key.
    expect(latestBundle(db)?.citations).toEqual([KEY_A]);
  });

  test("all citations hallucinated → noop, nothing enqueued", async () => {
    const db = await freshDb();
    const deps = makeDeps(db, [KEY_A]);
    const result = await act({
      action: "useless action",
      citations: [HALLUCINATED],
      userPrimaryEOA: FAKE_USER,
      _deps: depBundle(deps),
    });
    expect(result.citations).toEqual([]);
    expect(result.status).toBe("noop");
    expect(result.outboxId).toBeNull();
    expect(result.citationPayloadHashHex).toBeNull();
    expect(countOutbox(db, "pending")).toBe(0);
  });
});

describe("act — enqueued citation bundle", () => {
  test("valid citations enqueue ONE bundle with action + cites + payload", async () => {
    const db = await freshDb();
    const deps = makeDeps(db, [KEY_A, KEY_B]);
    deps.entityTypes.set(KEY_A, "observation");
    deps.entityTypes.set(KEY_B, "observation");

    const result = await act({
      action: "buy ETH",
      citations: [KEY_A, KEY_B],
      userPrimaryEOA: FAKE_USER,
      _deps: depBundle(deps),
    });

    expect(result.status).toBe("queued");
    expect(result.outboxId).not.toBeNull();
    expect(result.citationPayloadHashHex).toMatch(/^0x[0-9a-f]{64}$/);

    expect(countOutbox(db, "pending")).toBe(1);
    const bundle = latestBundle(db)!;
    expect(bundle.action).toBe("buy ETH");
    expect(bundle.citations).toEqual([KEY_A, KEY_B]);
    expect(bundle.userPrimaryEOA).toBe(FAKE_USER);
    expect(bundle.citationPayloadHashHex).toBe(result.citationPayloadHashHex!);
    // The CITATION attributes carry the audit shape the worker writes on-chain.
    const action = bundle.citationAttributes.find((a) => a.key === "action");
    expect(action?.value).toBe("buy ETH");
    const etype = bundle.citationAttributes.find((a) => a.key === "entityType");
    expect(etype?.value).toBe(ENTITY_TYPE.CITATION);
    const count = bundle.citationAttributes.find((a) => a.key === "citationCount");
    expect(count?.value).toBe(2);
    // Reinforce items cover both cited memories.
    expect(bundle.reinforceItems.map((i) => i.entityKey).sort()).toEqual(
      [KEY_A, KEY_B].sort(),
    );
  });
});

describe("act — citation counting", () => {
  test("valid citation increments count and uses working reinforcement", async () => {
    const db = await freshDb();
    const deps = makeDeps(db, [KEY_A]);
    deps.entityTypes.set(KEY_A, "observation");

    await act({
      action: "first cite",
      citations: [KEY_A],
      userPrimaryEOA: FAKE_USER,
      sessionId: "s1",
      _deps: depBundle(deps),
    });

    // First/unproven citation (weight = wInit) → exactly the base working lease.
    expect(latestBundle(db)?.reinforceItems[0]?.reinforcementSeconds).toBe(
      REINFORCEMENT.workingReinforcementSeconds,
    );
    const stats = await getCitationStats(KEY_A, db);
    expect(stats?.count).toBe(1);
    expect(stats?.distinctSessions).toBe(1);
    expect(stats?.lastSessionId).toBe("s1");
  });

  test("same session cites twice → count=2, distinctSessions stays 1", async () => {
    const db = await freshDb();
    const deps = makeDeps(db, [KEY_A]);
    deps.entityTypes.set(KEY_A, "observation");
    const bundle = depBundle(deps);

    await act({
      action: "first",
      citations: [KEY_A],
      userPrimaryEOA: FAKE_USER,
      sessionId: "s1",
      _deps: bundle,
    });
    await act({
      action: "second",
      citations: [KEY_A],
      userPrimaryEOA: FAKE_USER,
      sessionId: "s1",
      _deps: bundle,
    });

    const stats = await getCitationStats(KEY_A, db);
    expect(stats?.count).toBe(2);
    expect(stats?.distinctSessions).toBe(1);
    // One bundle per act.
    expect(countOutbox(db, "pending")).toBe(2);
  });

  test("different sessions citing same memory → distinctSessions increments", async () => {
    const db = await freshDb();
    const deps = makeDeps(db, [KEY_A]);
    deps.entityTypes.set(KEY_A, "observation");
    const bundle = depBundle(deps);

    for (const sid of ["s1", "s2", "s3"]) {
      await act({
        action: "cite",
        citations: [KEY_A],
        userPrimaryEOA: FAKE_USER,
        sessionId: sid,
        _deps: bundle,
      });
    }

    const stats = await getCitationStats(KEY_A, db);
    expect(stats?.count).toBe(3);
    expect(stats?.distinctSessions).toBe(3);
  });
});

describe("act — tier promotion", () => {
  test(`crossing promoteToEpisodic (${REINFORCEMENT.promoteToEpisodic}) enqueues an ownership transfer + marks promoted`, async () => {
    const db = await freshDb();
    const deps = makeDeps(db, [KEY_A]);
    deps.entityTypes.set(KEY_A, "observation");
    const bundle = depBundle(deps);

    // First citation: count=1, no promotion (threshold is 2).
    await act({
      action: "first",
      citations: [KEY_A],
      userPrimaryEOA: FAKE_USER,
      sessionId: "s1",
      _deps: bundle,
    });
    expect(latestBundle(db)?.promotionsToEpisode).toEqual([]);

    // Second citation: count=2 ≥ threshold → promotion enqueued + marked locally.
    const r2 = await act({
      action: "second",
      citations: [KEY_A],
      userPrimaryEOA: FAKE_USER,
      sessionId: "s2",
      _deps: bundle,
    });

    expect(latestBundle(db)?.promotionsToEpisode).toEqual([KEY_A]);
    expect(latestBundle(db)?.userPrimaryEOA).toBe(FAKE_USER);
    expect(r2.promotedKeys).toContain(KEY_A);

    // Row is marked promoted (optimistically) so the NEXT act doesn't re-fire.
    const stats = await getCitationStats(KEY_A, db);
    expect(stats?.promotedTo).toBe("episode");

    // Third citation: count=3, already promoted → no NEW promotion in the bundle.
    await act({
      action: "third",
      citations: [KEY_A],
      userPrimaryEOA: FAKE_USER,
      sessionId: "s3",
      _deps: bundle,
    });
    expect(latestBundle(db)?.promotionsToEpisode).toEqual([]);
  });

  test(`semantic threshold (${REINFORCEMENT.promoteToSemantic} cites across ${REINFORCEMENT.distinctSessionsForSemantic} sessions) flags promoted_to='rule'`, async () => {
    const db = await freshDb();
    const deps = makeDeps(db, [KEY_A]);
    // Tag it as 'episode' so it's in the semantic-eligible tier from the start.
    deps.entityTypes.set(KEY_A, "episode");
    const bundle = depBundle(deps);

    // Bump to count >= 5 across >= 3 distinct sessions.
    for (let i = 0; i < REINFORCEMENT.promoteToSemantic; i++) {
      await act({
        action: `cite${i}`,
        citations: [KEY_A],
        userPrimaryEOA: FAKE_USER,
        sessionId: `s${i % REINFORCEMENT.distinctSessionsForSemantic}`,
        _deps: bundle,
      });
    }

    const stats = await getCitationStats(KEY_A, db);
    expect(stats?.count).toBeGreaterThanOrEqual(REINFORCEMENT.promoteToSemantic);
    expect(stats?.distinctSessions).toBeGreaterThanOrEqual(
      REINFORCEMENT.distinctSessionsForSemantic,
    );
    expect(stats?.promotedTo).toBe("rule");
  });

  test("episode-tier citation uses episodicReinforcementSeconds (not working)", async () => {
    const db = await freshDb();
    const deps = makeDeps(db, [KEY_C]);
    deps.entityTypes.set(KEY_C, "episode");
    const bundle = depBundle(deps);

    await act({
      action: "cite ep",
      citations: [KEY_C],
      userPrimaryEOA: FAKE_USER,
      sessionId: "s1",
      _deps: bundle,
    });

    expect(latestBundle(db)?.reinforceItems[0]?.reinforcementSeconds).toBe(
      REINFORCEMENT.episodicReinforcementSeconds,
    );
  });
});

describe("act — input validation", () => {
  beforeEach(async () => {
    // no shared state; freshDb in each test
  });

  test("empty action string → throws", async () => {
    const db = await freshDb();
    await expect(
      act({
        action: "",
        citations: [KEY_A],
        userPrimaryEOA: FAKE_USER,
        _deps: depBundle(makeDeps(db, [KEY_A])),
      }),
    ).rejects.toThrow();
  });
});
