/**
 * Cortex — Ambient Dashboard server tests.
 *
 * Light tests:
 *   - JSON shape of /api/memories with a seeded SQLite mirror
 *   - JSON shape of /api/decisions
 *   - JSON shape of /api/listings + GLM aggregation
 *   - SIWE init → message format + nonce
 *
 * Visual review only for the React tree (per Phase 7 spec — no React render
 * tests). Server boot test lives in the build script; this file exercises the
 * handlers directly so we don't have to manage ports.
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { initMirrorDb, closeMirrorDb, encodeAttributes } from "../src/mirror/db";
import { PROJECT_ATTRIBUTE, ENTITY_TYPE } from "../src/constants";
import {
  handleMemoriesRequest,
  handleDecisionsRequest,
  handleListingsRequest,
  handleSiweInit,
  handleHealth,
} from "../src/ui-server";

const TEST_DB_PATH = `./cortex-mirror.dashboard-test-${Date.now()}.sqlite`;

beforeAll(async () => {
  process.env.CORTEX_MIRROR_PATH = TEST_DB_PATH;
  const db = await initMirrorDb();
  // Seed a working observation (90% lifespan remaining).
  const insert = db.prepare(
    `INSERT INTO entities (
      entity_key, owner, creator, content_type, payload, attributes_json,
      expires_at_block, created_at_block, last_modified_at_block,
      state, first_seen_block, last_event_block, last_event_type, hydrated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = Date.now();
  // current block estimate is derived from listMirroredEntities()[0].lastEventBlock.
  // Seed last_event_block = 100000 for predictability.
  const lastBlock = 100_000;
  const working = {
    entity_key: "0x" + "11".repeat(32),
    owner: "0x" + "ab".repeat(20),
    creator: "0x" + "cd".repeat(20),
    content_type: "application/octet-stream",
    payload: new Uint8Array([1, 2, 3, 4]),
    attributes_json: encodeAttributes([
      { key: PROJECT_ATTRIBUTE.key, value: PROJECT_ATTRIBUTE.value },
      { key: "entityType", value: ENTITY_TYPE.OBSERVATION },
    ]),
    expires_at_block: lastBlock + 1500, // ~50 min remaining (1h working lifespan)
    created_at_block: lastBlock - 100,
    last_modified_at_block: lastBlock,
    state: "live",
    first_seen_block: lastBlock - 100,
    last_event_block: lastBlock,
    last_event_type: "created",
    hydrated_at_ms: now,
  };
  insert.run(
    working.entity_key,
    working.owner,
    working.creator,
    working.content_type,
    working.payload,
    working.attributes_json,
    working.expires_at_block,
    working.created_at_block,
    working.last_modified_at_block,
    working.state,
    working.first_seen_block,
    working.last_event_block,
    working.last_event_type,
    working.hydrated_at_ms,
  );

  // Seed an episode.
  const episode = {
    ...working,
    entity_key: "0x" + "22".repeat(32),
    payload: new Uint8Array([5, 6, 7]),
    attributes_json: encodeAttributes([
      { key: PROJECT_ATTRIBUTE.key, value: PROJECT_ATTRIBUTE.value },
      { key: "entityType", value: ENTITY_TYPE.EPISODE },
    ]),
    expires_at_block: lastBlock + 200_000,
  };
  insert.run(
    episode.entity_key,
    episode.owner,
    episode.creator,
    episode.content_type,
    episode.payload,
    episode.attributes_json,
    episode.expires_at_block,
    episode.created_at_block,
    episode.last_modified_at_block,
    episode.state,
    episode.first_seen_block,
    episode.last_event_block,
    episode.last_event_type,
    episode.hydrated_at_ms,
  );

  // Seed a citation (act() record) referencing the working observation.
  const citationPayload = new TextEncoder().encode(
    JSON.stringify({
      action: "rebalance vault to USDC",
      citedKeys: [working.entity_key],
    }),
  );
  const citation = {
    ...working,
    entity_key: "0x" + "33".repeat(32),
    payload: citationPayload,
    content_type: "application/json",
    attributes_json: encodeAttributes([
      { key: PROJECT_ATTRIBUTE.key, value: PROJECT_ATTRIBUTE.value },
      { key: "entityType", value: ENTITY_TYPE.CITATION },
    ]),
    expires_at_block: lastBlock + 500,
  };
  insert.run(
    citation.entity_key,
    citation.owner,
    citation.creator,
    citation.content_type,
    citation.payload,
    citation.attributes_json,
    citation.expires_at_block,
    citation.created_at_block,
    citation.last_modified_at_block,
    citation.state,
    citation.first_seen_block,
    citation.last_event_block,
    citation.last_event_type,
    citation.hydrated_at_ms,
  );

  // Seed a listing + a matching grant (sale).
  const listingKey = "0x" + "44".repeat(32);
  const listing = {
    ...working,
    entity_key: listingKey,
    payload: new Uint8Array([0xfe]),
    attributes_json: encodeAttributes([
      { key: PROJECT_ATTRIBUTE.key, value: PROJECT_ATTRIBUTE.value },
      { key: "entityType", value: ENTITY_TYPE.LISTING },
      { key: "priceWei", value: "5000000000000000" }, // 0.005 GLM
      { key: "category", value: "anti-rug" },
    ]),
    expires_at_block: lastBlock + 300_000,
  };
  insert.run(
    listing.entity_key,
    listing.owner,
    listing.creator,
    listing.content_type,
    listing.payload,
    listing.attributes_json,
    listing.expires_at_block,
    listing.created_at_block,
    listing.last_modified_at_block,
    listing.state,
    listing.first_seen_block,
    listing.last_event_block,
    listing.last_event_type,
    listing.hydrated_at_ms,
  );
  const grant = {
    ...working,
    entity_key: "0x" + "55".repeat(32),
    payload: new Uint8Array([0xab]),
    attributes_json: encodeAttributes([
      { key: PROJECT_ATTRIBUTE.key, value: PROJECT_ATTRIBUTE.value },
      { key: "entityType", value: ENTITY_TYPE.GRANT },
      { key: "listingKey", value: listingKey },
      { key: "priceWei", value: "5000000000000000" },
    ]),
    expires_at_block: lastBlock + 1000,
  };
  insert.run(
    grant.entity_key,
    grant.owner,
    grant.creator,
    grant.content_type,
    grant.payload,
    grant.attributes_json,
    grant.expires_at_block,
    grant.created_at_block,
    grant.last_modified_at_block,
    grant.state,
    grant.first_seen_block,
    grant.last_event_block,
    grant.last_event_type,
    grant.hydrated_at_ms,
  );
});

afterAll(async () => {
  closeMirrorDb();
  try {
    await Bun.file(TEST_DB_PATH).delete();
    await Bun.file(`${TEST_DB_PATH}-wal`).delete();
    await Bun.file(`${TEST_DB_PATH}-shm`).delete();
  } catch {
    /* ignore */
  }
});

test("/api/health returns project + chain", async () => {
  const res = await handleHealth(new Request("http://x/api/health"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; project: string; chainId: number };
  expect(body.ok).toBe(true);
  expect(body.project).toBe(PROJECT_ATTRIBUTE.value);
  expect(typeof body.chainId).toBe("number");
});

test("/api/memories returns tier counts + remainingRatio", async () => {
  const res = await handleMemoriesRequest(new Request("http://x/api/memories"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    counts: { total: number; working: number; episodic: number; rule: number };
    memories: Array<{
      tier: string;
      entityType: string | null;
      remainingRatio: number;
      remainingSeconds: number;
      lifespanSeconds: number;
    }>;
  };
  expect(body.counts.total).toBeGreaterThanOrEqual(2);
  expect(body.counts.working).toBeGreaterThanOrEqual(1);
  expect(body.counts.episodic).toBeGreaterThanOrEqual(1);
  const working = body.memories.find((m) => m.tier === "working");
  expect(working).toBeTruthy();
  expect(working!.remainingRatio).toBeGreaterThan(0);
  expect(working!.remainingRatio).toBeLessThanOrEqual(1);
  expect(working!.lifespanSeconds).toBe(3600);
});

test("/api/decisions extracts action + citedKeys from citation payload", async () => {
  const res = await handleDecisionsRequest(new Request("http://x/api/decisions"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    decisions: Array<{ action: string; citedKeys: string[] }>;
  };
  expect(body.decisions.length).toBe(1);
  expect(body.decisions[0]!.action).toBe("rebalance vault to USDC");
  expect(body.decisions[0]!.citedKeys.length).toBe(1);
  expect(body.decisions[0]!.citedKeys[0]).toMatch(/^0x11+$/);
});

test("/api/listings aggregates GLM totalEarnedWei across grants", async () => {
  const res = await handleListingsRequest(new Request("http://x/api/listings"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    listings: Array<{ priceWei: string; sales: number; totalEarnedWei: string }>;
    aggregate: { totalEarnedWei: string; activeListings: number };
  };
  expect(body.listings.length).toBe(1);
  expect(body.listings[0]!.sales).toBe(1);
  expect(body.listings[0]!.priceWei).toBe("5000000000000000");
  expect(body.listings[0]!.totalEarnedWei).toBe("5000000000000000");
  expect(body.aggregate.totalEarnedWei).toBe("5000000000000000");
  expect(body.aggregate.activeListings).toBe(1);
});

test("/api/auth/siwe/init issues nonce + ERC-4361 message", async () => {
  const res = await handleSiweInit(
    new Request("http://x/api/auth/siwe/init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        address: "0x" + "ab".repeat(20),
        domain: "localhost:3000",
        uri: "http://localhost:3000",
      }),
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { message: string; nonce: string };
  expect(body.nonce.length).toBeGreaterThanOrEqual(8);
  expect(body.message).toContain("localhost:3000 wants you to sign in");
  expect(body.message).toContain("URI: http://localhost:3000");
  expect(body.message).toContain("Chain ID: 60138453102");
});

test("POST /api/auth/adopt 401 without SIWE cookie", async () => {
  const { handleAdoptRequest } = await import("../src/api/auth-adopt");
  const req = new Request("http://localhost/api/auth/adopt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      address: "0x" + "11".repeat(20),
      signature: "0x" + "ab".repeat(65),
    }),
  });
  const res = await handleAdoptRequest(req);
  expect(res.status).toBe(401);
});

test("GET /api/auth/me returns source 'none' when nothing set", async () => {
  const { _resetOwnerIdentity } = await import("../src/agent/owner-identity");
  const savedUser = process.env.USER_PRIMARY_ADDRESS;
  const savedSig = process.env.CORTEX_USER_SIGNATURE;
  const savedPk = process.env.CORTEX_USER_PRIVATE_KEY;
  delete process.env.USER_PRIMARY_ADDRESS;
  delete process.env.CORTEX_USER_SIGNATURE;
  delete process.env.CORTEX_USER_PRIVATE_KEY;
  _resetOwnerIdentity();
  const { handleAuthMe } = await import("../src/api/auth-adopt");
  const res = await handleAuthMe(new Request("http://localhost/api/auth/me"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ownerAddress: string | null; source: string };
  expect(body.source).toBe("none");
  expect(body.ownerAddress).toBeNull();
  if (savedUser !== undefined) process.env.USER_PRIMARY_ADDRESS = savedUser;
  if (savedSig !== undefined) process.env.CORTEX_USER_SIGNATURE = savedSig;
  if (savedPk !== undefined) process.env.CORTEX_USER_PRIVATE_KEY = savedPk;
  _resetOwnerIdentity();
});
