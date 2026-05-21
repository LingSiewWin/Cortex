/**
 * Phase 5 — act() / citation tracker tests.
 *
 * Verifies the Darwinian engine's behavioral contract:
 *   1. Citations that aren't in the last recall set are silently dropped
 *      (hallucination defense). Their counts never bump.
 *   2. Citations that ARE in the last recall set bump the count, fire an
 *      accumulative extend, and produce a tx hash.
 *   3. Crossing REINFORCEMENT.promoteToEpisodic triggers ownership promotion
 *      to the user EOA and marks the row promoted_to='episode'.
 *   4. Crossing REINFORCEMENT.promoteToSemantic + distinctSessionsForSemantic
 *      flags the memory for distillation (promoted_to='rule').
 *
 * The mirror DB is dependency-injected (in-memory sqlite) so tests don't touch
 * the dev mirror or Braga.
 */

import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import type { Hex } from "@arkiv-network/sdk";
import { act, getCitationStats } from "../src/darwinian/citation.ts";
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
  reinforceTxHashes: string[];
  promoteTxHashes: string[];
  citationWriteTxHashes: string[];
  reinforceItems: { entityKey: Hex; reinforcementSeconds: number }[][];
  promoteCalls: { keys: Hex[]; userEOA: Hex }[];
  citationWrites: { action: string; citations: Hex[] }[];
  entityTypes: Map<Hex, "observation" | "episode" | "rule">;
}

function makeDeps(db: Database, lastIds: Hex[]): ScenarioDeps {
  return {
    db,
    lastRecallIds: new Set(lastIds),
    reinforceTxHashes: [],
    promoteTxHashes: [],
    citationWriteTxHashes: [],
    reinforceItems: [],
    promoteCalls: [],
    citationWrites: [],
    entityTypes: new Map(),
  };
}

function depBundle(s: ScenarioDeps) {
  return {
    db: s.db,
    lastRecallIds: () => s.lastRecallIds,
    reinforce: async (items: { entityKey: Hex; reinforcementSeconds: number }[]) => {
      s.reinforceItems.push(items);
      const tx = `0xreinforce${s.reinforceTxHashes.length.toString(16).padStart(2, "0")}`;
      s.reinforceTxHashes.push(tx);
      return tx;
    },
    promote: async (keys: readonly Hex[], userEOA: Hex) => {
      s.promoteCalls.push({ keys: [...keys], userEOA });
      const tx = `0xpromote${s.promoteTxHashes.length.toString(16).padStart(2, "0")}`;
      s.promoteTxHashes.push(tx);
      return { txHash: tx };
    },
    writeCitationEntity: async (input: { action: string; citations: Hex[] }) => {
      s.citationWrites.push({ action: input.action, citations: [...input.citations] });
      const idx = s.citationWriteTxHashes.length;
      const tx = `0xcite${idx.toString(16).padStart(2, "0")}`;
      s.citationWriteTxHashes.push(tx);
      // Fake entity key — deterministic, hex-32-byte shape.
      const entityKey =
        `0xc174${idx.toString(16).padStart(4, "0")}${"0".repeat(56)}` as Hex;
      return { entityKey, txHash: tx };
    },
    entityTypeOf: (k: Hex) => s.entityTypes.get(k),
  };
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
  });

  test("all citations hallucinated → no reinforce tx, no promote tx, no citation entity", async () => {
    const db = await freshDb();
    const deps = makeDeps(db, [KEY_A]);
    const result = await act({
      action: "useless action",
      citations: [HALLUCINATED],
      userPrimaryEOA: FAKE_USER,
      _deps: depBundle(deps),
    });
    expect(result.citations).toEqual([]);
    expect(result.txHashes).toEqual([]);
    expect(result.citationEntityKey).toBeNull();
    expect(deps.reinforceItems.length).toBe(0);
    expect(deps.promoteCalls.length).toBe(0);
    expect(deps.citationWrites.length).toBe(0);
  });
});

describe("act — citation entity write", () => {
  test("valid citations trigger a CITATION entity write with action + cites", async () => {
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

    expect(deps.citationWrites.length).toBe(1);
    expect(deps.citationWrites[0]?.action).toBe("buy ETH");
    expect(deps.citationWrites[0]?.citations).toEqual([KEY_A, KEY_B]);
    expect(result.citationEntityKey).not.toBeNull();
    expect(result.txHashes[0]).toMatch(/^0xcite/);
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

    expect(deps.reinforceItems[0]?.[0]?.reinforcementSeconds).toBe(
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
  test(`crossing promoteToEpisodic (${REINFORCEMENT.promoteToEpisodic}) triggers ownership transfer`, async () => {
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
    expect(deps.promoteCalls.length).toBe(0);

    // Second citation: count=2 ≥ threshold → promote.
    const r2 = await act({
      action: "second",
      citations: [KEY_A],
      userPrimaryEOA: FAKE_USER,
      sessionId: "s2",
      _deps: bundle,
    });

    expect(deps.promoteCalls.length).toBe(1);
    expect(deps.promoteCalls[0]?.keys).toEqual([KEY_A]);
    expect(deps.promoteCalls[0]?.userEOA).toBe(FAKE_USER);
    expect(r2.promotedKeys).toContain(KEY_A);

    // Row is marked promoted so the NEXT act doesn't re-fire.
    const stats = await getCitationStats(KEY_A, db);
    expect(stats?.promotedTo).toBe("episode");

    // Third citation: count=3, already promoted → no NEW promote call.
    await act({
      action: "third",
      citations: [KEY_A],
      userPrimaryEOA: FAKE_USER,
      sessionId: "s3",
      _deps: bundle,
    });
    expect(deps.promoteCalls.length).toBe(1); // still 1
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

    expect(deps.reinforceItems[0]?.[0]?.reinforcementSeconds).toBe(
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
