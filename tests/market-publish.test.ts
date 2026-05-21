/**
 * Cortex — Synaptic Market: publish + discovery unit tests.
 *
 * Pure unit tests — DO NOT touch Braga. We mock the two Arkiv interfaces the
 * market code uses:
 *
 *   - singleCreate (batch-writer): hand back a deterministic txHash + entityKey
 *     and stash the create spec in an in-memory store.
 *
 *   - cortexQuery (arkiv-client): return entities from the in-memory store,
 *     respecting the .where(eq(...)) predicates and .withPayload() flag.
 *
 * Coverage:
 *   1. publishListing stamps the right attributes on the Arkiv entity
 *   2. AES round-trip: openPayload(key, payload) recovers the original ruleText
 *   3. browseListings({ ruleTag }) finds listings published with that tag
 *   4. publishListing input validation rejects bad confidence / negative price
 *
 * No PROJECT_ATTRIBUTE assertion needed — that's batch-writer's job and is
 * covered by tests/smoke-create-read.test.ts.
 *
 * ---------------------------------------------------------------------------
 * Test isolation primer (read before editing the mocks below)
 * ---------------------------------------------------------------------------
 *
 * `bun test` runs every test file in a single process, and `mock.module()` is
 * process-wide. `mock.restore()` does NOT reset module mocks
 * (see bun-types/docs/test/mocks.mdx §"Restore All Mocks"). Top-level
 * `mock.module()` calls run during the import phase of THIS file, but Bun
 * imports test files lazily as they run, so the mock can still affect later
 * files that import the same module path.
 *
 * To keep the mock scoped to THIS file:
 *   1. Capture the real modules in `beforeAll` (they were imported as
 *      `* as ...Real` at module top — that import predates any mock.module()
 *      call we add below).
 *   2. Apply the stub mocks in `beforeAll`.
 *   3. Restore by re-mocking with the real exports in `afterAll`.
 *
 * This is "option C" from the FIXER D brief: the mock is global, but it only
 * exists for the window between this file's beforeAll and afterAll. Any test
 * file that runs entirely before or after this file's hooks sees the real
 * modules.
 */

import { test, expect, mock, beforeAll, beforeEach, afterAll } from "bun:test";

import type { Database } from "bun:sqlite";
import type { Hex } from "@arkiv-network/sdk";

// Real-module captures. CRITICAL: `import * as X` creates LIVE bindings — if
// we later call mock.module() on the same path, the namespace object updates
// in place and we lose access to the real exports. We must snapshot the
// exports into plain objects HERE, during the parse phase (before any
// mock.module() runs), and use those snapshots as the restoration target.
import * as ArkivClientLive from "../src/lib/arkiv-client";
import * as BatchWriterLive from "../src/lib/batch-writer";
import * as MirrorDbLive from "../src/mirror/db";

const ArkivClientReal: typeof ArkivClientLive = { ...ArkivClientLive };
const BatchWriterReal: typeof BatchWriterLive = { ...BatchWriterLive };
const MirrorDbReal: typeof MirrorDbLive = { ...MirrorDbLive };

// Modules-under-test. Imported eagerly; their `import { singleCreate } from
// "../lib/batch-writer"` etc. bindings are LIVE — when we mock.module() those
// paths in beforeAll, the bindings update automatically (per Bun docs
// §"Overriding Already Imported Modules").
import { publishListing } from "../src/market/publish";
import { browseListings } from "../src/market/decrypt-grant";
import { openPayload, sealPayload } from "../src/lib/crypto";
import { saveListingKey, loadAllListingKeys } from "../src/mirror/db";
import { ENTITY_TYPE } from "../src/constants";

// ---------------------------------------------------------------------------
// Mock infra
// ---------------------------------------------------------------------------

type MockAttribute = { key: string; value: string | number };
interface MockEntity {
  key: Hex;
  payload: Uint8Array;
  attributes: MockAttribute[];
  contentType: string;
  expiresInSeconds: number;
}

const STORE: MockEntity[] = [];
let entityCounter = 0;

function nextEntityKey(): Hex {
  entityCounter++;
  const hex = entityCounter.toString(16).padStart(64, "0");
  return `0x${hex}` as Hex;
}

function nextTxHash(): Hex {
  const hex = ((entityCounter * 7919) & 0xffffffff).toString(16).padStart(64, "f");
  return `0x${hex}` as Hex;
}

// Build a chainable mock query builder. Tracks .where predicates and applies
// them on .fetch(). Predicate shape matches @arkiv-network/sdk/query/predicate:
//   { type: "eq", key, value }
interface MockPredicate {
  type: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "not";
  key: string;
  value: string | number;
}

function mockBuilder() {
  const predicates: MockPredicate[] = [];
  let withPayloadFlag = false;
  const builder = {
    where(p: MockPredicate | MockPredicate[]) {
      if (Array.isArray(p)) predicates.push(...p);
      else predicates.push(p);
      return builder;
    },
    withAttributes() {
      return builder;
    },
    withMetadata() {
      return builder;
    },
    withPayload(flag: boolean = true) {
      withPayloadFlag = flag;
      return builder;
    },
    limit() {
      return builder;
    },
    orderBy() {
      return builder;
    },
    createdBy() {
      return builder;
    },
    ownedBy() {
      return builder;
    },
    async fetch() {
      const matches = STORE.filter((e) =>
        predicates.every((p) => {
          // PROJECT_ATTRIBUTE predicate is always present — auto-pass since
          // batch-writer adds it for us (we don't simulate that in the mock).
          if (p.key === "project") return true;
          return e.attributes.some(
            (a) => a.key === p.key && a.value === p.value,
          );
        }),
      );
      return {
        entities: matches.map((e) => ({
          key: e.key,
          attributes: e.attributes,
          payload: withPayloadFlag ? e.payload : undefined,
          owner: "0x0000000000000000000000000000000000000001" as Hex,
          creator: "0x0000000000000000000000000000000000000001" as Hex,
        })),
      };
    },
  };
  return builder;
}

interface MockListingKeyRow {
  entityKey: Hex;
  sealed: Uint8Array;
  nonce: Uint8Array;
}
const LISTING_KEY_TABLE: MockListingKeyRow[] = [];

// ---------------------------------------------------------------------------
// Lifecycle: install mocks BEFORE this file's tests, restore them AFTER.
// ---------------------------------------------------------------------------

beforeAll(() => {
  mock.module("../src/lib/arkiv-client", () => ({
    ...ArkivClientReal,
    cortexQuery: () => mockBuilder(),
    getSessionKeyAddress: () =>
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex,
    stampProjectAttribute: (a: MockAttribute[]) => a,
  }));

  mock.module("../src/lib/batch-writer", () => ({
    ...BatchWriterReal,
    singleCreate: async (item: {
      payload: Uint8Array;
      attributes: MockAttribute[];
      contentType: string;
      expiresInSeconds: number;
    }) => {
      const key = nextEntityKey();
      STORE.push({
        key,
        payload: item.payload,
        attributes: [...item.attributes],
        contentType: item.contentType,
        expiresInSeconds: item.expiresInSeconds,
      });
      return { entityKey: key, txHash: nextTxHash() };
    },
  }));

  mock.module("../src/mirror/db", () => ({
    ...MirrorDbReal,
    saveListingKey: (
      _db: unknown,
      entityKey: Hex,
      sealed: Uint8Array,
      nonce: Uint8Array,
    ) => {
      const existing = LISTING_KEY_TABLE.findIndex(
        (r) => r.entityKey === entityKey,
      );
      const row = {
        entityKey,
        sealed: new Uint8Array(sealed),
        nonce: new Uint8Array(nonce),
      };
      if (existing >= 0) LISTING_KEY_TABLE[existing] = row;
      else LISTING_KEY_TABLE.push(row);
    },
    loadAllListingKeys: (_db: unknown) =>
      LISTING_KEY_TABLE.map((r) => ({
        entityKey: r.entityKey,
        sealed: new Uint8Array(r.sealed),
        nonce: new Uint8Array(r.nonce),
      })),
  }));
});

afterAll(() => {
  // Re-mock with the original modules. The only Bun-supported way to undo a
  // `mock.module()` as of v1.3 (mock.restore() is documented NOT to touch
  // module mocks).
  mock.module("../src/lib/arkiv-client", () => ArkivClientReal);
  mock.module("../src/lib/batch-writer", () => BatchWriterReal);
  mock.module("../src/mirror/db", () => MirrorDbReal);
});

beforeEach(() => {
  STORE.length = 0;
  entityCounter = 0;
  LISTING_KEY_TABLE.length = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("publishListing stamps the right attributes", async () => {
  const result = await publishListing({
    ruleText: "do not trade tokens with hidden mint authority",
    ruleTag: "anti_rug_v1",
    confidence: 93,
    priceWei: 5_000_000_000_000_000n,
  });

  expect(result.entityKey).toMatch(/^0x[0-9a-f]{64}$/);
  expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  expect(result.priceWei).toBe(5_000_000_000_000_000n);
  expect(result.decryptionKey).toBeInstanceOf(Uint8Array);
  expect(result.decryptionKey.length).toBe(32);

  const stored = STORE.find((e) => e.key === result.entityKey);
  expect(stored).toBeDefined();
  const attrMap = new Map(stored!.attributes.map((a) => [a.key, a.value]));
  expect(attrMap.get("entityType")).toBe(ENTITY_TYPE.LISTING);
  expect(attrMap.get("ruleTag")).toBe("anti_rug_v1");
  expect(attrMap.get("confidence")).toBe(93);
  expect(attrMap.get("priceWei")).toBe("5000000000000000");
  expect(attrMap.get("seller")).toBeDefined();
});

test("AES round-trip: openPayload recovers the original ruleText", async () => {
  const original = "If LP unlock <7 days, halve position. Survives 5 sessions.";
  const result = await publishListing({
    ruleText: original,
    ruleTag: "memecoin_safety",
    confidence: 81,
    priceWei: 1_000_000_000_000_000n,
  });

  const stored = STORE.find((e) => e.key === result.entityKey);
  expect(stored).toBeDefined();

  // Re-import the raw key into a CryptoKey and decrypt.
  const buf = new ArrayBuffer(result.decryptionKey.byteLength);
  new Uint8Array(buf).set(result.decryptionKey);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    buf,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );

  const plaintextBytes = await openPayload(cryptoKey, stored!.payload);
  expect(new TextDecoder().decode(plaintextBytes)).toBe(original);
});

test("browseListings({ ruleTag }) finds listings with that tag", async () => {
  await publishListing({
    ruleText: "rule A",
    ruleTag: "anti_rug_v1",
    confidence: 91,
    priceWei: 1_000n,
  });
  await publishListing({
    ruleText: "rule B",
    ruleTag: "memecoin_safety",
    confidence: 70,
    priceWei: 2_000n,
  });
  await publishListing({
    ruleText: "rule C",
    ruleTag: "anti_rug_v1",
    confidence: 85,
    priceWei: 3_000n,
  });

  const found = await browseListings({ ruleTag: "anti_rug_v1" });
  expect(found.length).toBe(2);
  // Sorted by confidence desc.
  expect(found[0]?.confidence).toBe(91);
  expect(found[1]?.confidence).toBe(85);
  for (const l of found) {
    expect(l.ruleTag).toBe("anti_rug_v1");
    expect(typeof l.priceWei).toBe("bigint");
  }
});

test("browseListings({ maxPriceWei }) filters out expensive listings", async () => {
  await publishListing({
    ruleText: "cheap",
    ruleTag: "anti_rug_v1",
    confidence: 95,
    priceWei: 500n,
  });
  await publishListing({
    ruleText: "expensive",
    ruleTag: "anti_rug_v1",
    confidence: 95,
    priceWei: 10_000n,
  });

  const found = await browseListings({
    ruleTag: "anti_rug_v1",
    maxPriceWei: 1_000n,
  });
  expect(found.length).toBe(1);
  expect(found[0]?.priceWei).toBe(500n);
});

test("publishListing rejects bad confidence", async () => {
  await expect(
    publishListing({
      ruleText: "x",
      ruleTag: "anti_rug_v1",
      confidence: 150,
      priceWei: 0n,
    }),
  ).rejects.toThrow(/confidence/);

  await expect(
    publishListing({
      ruleText: "x",
      ruleTag: "anti_rug_v1",
      confidence: -1,
      priceWei: 0n,
    }),
  ).rejects.toThrow(/confidence/);
});

test("publishListing rejects negative price", async () => {
  await expect(
    publishListing({
      ruleText: "x",
      ruleTag: "anti_rug_v1",
      confidence: 80,
      priceWei: -1n,
    }),
  ).rejects.toThrow(/priceWei/);
});

test("publishListing rejects empty ruleText / ruleTag", async () => {
  await expect(
    publishListing({
      ruleText: "",
      ruleTag: "anti_rug_v1",
      confidence: 80,
      priceWei: 0n,
    }),
  ).rejects.toThrow(/ruleText/);

  await expect(
    publishListing({
      ruleText: "x",
      ruleTag: "",
      confidence: 80,
      priceWei: 0n,
    }),
  ).rejects.toThrow(/ruleTag/);
});

// ---------------------------------------------------------------------------
// Restart-safety: listing_keys persistence + reload
// ---------------------------------------------------------------------------

// Build a one-off CryptoKey that stands in for the user-derived payload key.
// Tests don't need the actual HKDF derivation — any AES-256-GCM key works.
async function makeUserKey(): Promise<CryptoKey> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const buf = new ArrayBuffer(raw.byteLength);
  new Uint8Array(buf).set(raw);
  return crypto.subtle.importKey(
    "raw",
    buf,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

test("publishListing writes a listing_keys row when userKey + db are passed", async () => {
  const userKey = await makeUserKey();
  const fakeDb = {} as unknown as Database;

  const result = await publishListing({
    ruleText: "do not approve unverified routers",
    ruleTag: "anti_rug_v1",
    confidence: 90,
    priceWei: 1_000n,
    userKey,
    db: fakeDb,
  });

  const rows = loadAllListingKeys(fakeDb);
  const persisted = rows.find((r) => r.entityKey === result.entityKey);
  expect(persisted).toBeDefined();
  expect(persisted!.sealed.length).toBeGreaterThan(0);
  // AES-GCM nonce is 12 bytes per lib/crypto.ts.
  expect(persisted!.nonce.length).toBe(12);
});

test("daemon-reload: loadAllListingKeys round-trips back to the original AES key", async () => {
  const userKey = await makeUserKey();
  const fakeDb = {} as unknown as Database;

  const result = await publishListing({
    ruleText: "halve memecoin position when LP unlock <7d",
    ruleTag: "memecoin_safety",
    confidence: 82,
    priceWei: 2_000n,
    userKey,
    db: fakeDb,
  });

  // Simulate a process restart: drop the in-memory map, reload from the
  // SQLite mirror, unseal each sealed key with the same userKey.
  const rows = loadAllListingKeys(fakeDb);
  expect(rows.length).toBe(1);
  const row = rows[0]!;

  // Reassemble [nonce || sealed] (the layout sealPayload writes), then unseal.
  const reassembled = new Uint8Array(row.nonce.length + row.sealed.length);
  reassembled.set(row.nonce, 0);
  reassembled.set(row.sealed, row.nonce.length);
  const recovered = await openPayload(userKey, reassembled);

  // Recovered key should match the raw key publishListing returned.
  expect(recovered).toEqual(result.decryptionKey);
});

test("publishListing throws when db is passed without userKey", async () => {
  const fakeDb = {} as unknown as Database;
  await expect(
    publishListing({
      ruleText: "x",
      ruleTag: "anti_rug_v1",
      confidence: 80,
      priceWei: 0n,
      db: fakeDb,
    }),
  ).rejects.toThrow(/userKey/);
});

test("saveListingKey + loadAllListingKeys upserts cleanly", async () => {
  const fakeDb = {} as unknown as Database;
  const userKey = await makeUserKey();
  const entityKey =
    "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;
  const payload = new Uint8Array([1, 2, 3, 4]);
  const sealed = await sealPayload(userKey, payload);
  const nonce = sealed.slice(0, 12);
  const ct = sealed.slice(12);

  saveListingKey(fakeDb, entityKey, ct, nonce);
  saveListingKey(fakeDb, entityKey, ct, nonce); // second call is upsert
  const rows = loadAllListingKeys(fakeDb);
  expect(rows.length).toBe(1);
  expect(rows[0]!.entityKey).toBe(entityKey);
});
