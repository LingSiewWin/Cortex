/**
 * Cortex — encryption-at-rest tests (the sovereignty keystone).
 *
 * Verifies that memory payloads sealed with the wallet-derived key are:
 *   1. opened in RAM during recall (chain/mirror hold ciphertext) and scored;
 *   2. SKIPPED — not crashed on — when no wallet key is present (the negative
 *      control that proves the wallet is load-bearing);
 *   3. skipped when the wrong key can't open them;
 *   4. backward-compatible: plaintext candidates (no contentType) still score.
 *
 * Pure in-memory: recall's Arkiv read + embedding + weight lookup are injected
 * via `_deps`, and the payload key via the payload-key test seam. No Braga.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import type { Hex } from "@arkiv-network/sdk";
import { recall, _resetLastRecallIds, type RecallCandidate } from "../src/darwinian/recall";
import {
  _setPayloadKeyForTest,
  _resetPayloadKey,
  getPayloadKey,
} from "../src/lib/payload-key";
import { derivePayloadKey, sealPayload, openPayload } from "../src/lib/crypto";
import { rabitqEncode, packCode } from "../src/compression/rabitq";
import { SEALED_CONTENT_TYPE, ENTITY_TYPE } from "../src/constants";

const EMBED_DIM = 1536;
const SIG_A = ("0x" + "ab".repeat(65)) as Hex; // 65-byte EIP-191 sig (fixed)
const SIG_B = ("0x" + "cd".repeat(65)) as Hex; // a different wallet

const KEY_OBS = "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;
const KEY_RULE = "0x2222222222222222222222222222222222222222222222222222222222222222" as Hex;

function makeLcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

/** Deterministic unit vector so memory == query gives a high inner-product. */
function unitVector(seed: number): Float32Array {
  const rng = makeLcg(seed);
  const v = new Float32Array(EMBED_DIM);
  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) {
    const x = rng() * 2 - 1;
    v[i] = x;
    norm += x * x;
  }
  const inv = 1 / Math.sqrt(norm);
  for (let i = 0; i < EMBED_DIM; i++) v[i]! *= inv;
  return v;
}

const memVec = unitVector(42);
const packedObs = packCode(rabitqEncode(memVec)); // 198 bytes plaintext RaBitQ

async function sealedCandidate(
  key: CryptoKey,
  entityKey: Hex,
  raw: Uint8Array,
  entityType: string,
): Promise<RecallCandidate> {
  return {
    key: entityKey,
    payload: await sealPayload(key, raw),
    attributes: [{ key: "entityType", value: entityType }],
    expiresAtBlock: 1_000_000n,
    contentType: SEALED_CONTENT_TYPE,
  };
}

function deps(candidates: RecallCandidate[], queryVec: Float32Array) {
  return {
    fetchCandidates: async () => candidates,
    embedQuery: async () => queryVec,
    loadWeights: async () => new Map<Hex, number>(), // → wInit factor 1.0
  };
}

beforeEach(() => {
  _resetPayloadKey();
  _resetLastRecallIds();
  delete process.env.CORTEX_USER_SIGNATURE;
  delete process.env.CORTEX_USER_PRIVATE_KEY;
});
afterEach(() => {
  _resetPayloadKey();
  delete process.env.CORTEX_USER_SIGNATURE;
  delete process.env.CORTEX_USER_PRIVATE_KEY;
});

test("seal → open round-trips the raw bytes", async () => {
  const key = await derivePayloadKey(SIG_A);
  const sealed = await sealPayload(key, packedObs);
  expect(sealed.length).toBeGreaterThan(packedObs.length); // nonce + tag overhead
  const opened = await openPayload(key, sealed);
  expect(Array.from(opened)).toEqual(Array.from(packedObs));
});

test("recall opens a sealed observation and scores it", async () => {
  const key = await derivePayloadKey(SIG_A);
  _setPayloadKeyForTest(key);
  const cand = await sealedCandidate(key, KEY_OBS, packedObs, ENTITY_TYPE.OBSERVATION);
  const hits = await recall({ query: "anything", k: 5, _deps: deps([cand], memVec) });
  expect(hits.length).toBe(1);
  expect(hits[0]!.entityKey).toBe(KEY_OBS);
  expect(hits[0]!.score).toBeGreaterThan(0);
});

test("recall SKIPS sealed memory when no wallet key (negative control, no crash)", async () => {
  _setPayloadKeyForTest(null); // no wallet
  const key = await derivePayloadKey(SIG_A); // used only to seal the fixture
  const cand = await sealedCandidate(key, KEY_OBS, packedObs, ENTITY_TYPE.OBSERVATION);
  const hits = await recall({ query: "anything", k: 5, _deps: deps([cand], memVec) });
  expect(hits.length).toBe(0); // present on "chain" but unreadable → miss
});

test("recall skips a sealed memory it can't open (wrong wallet)", async () => {
  const keyA = await derivePayloadKey(SIG_A);
  const keyB = await derivePayloadKey(SIG_B);
  _setPayloadKeyForTest(keyB); // recall holds the WRONG key
  const cand = await sealedCandidate(keyA, KEY_OBS, packedObs, ENTITY_TYPE.OBSERVATION);
  const hits = await recall({ query: "anything", k: 5, _deps: deps([cand], memVec) });
  expect(hits.length).toBe(0);
});

test("recall still scores plaintext candidates (backward compatible)", async () => {
  _setPayloadKeyForTest(null);
  const cand: RecallCandidate = {
    key: KEY_OBS,
    payload: packedObs, // plaintext, no contentType
    attributes: [{ key: "entityType", value: ENTITY_TYPE.OBSERVATION }],
    expiresAtBlock: 1_000_000n,
  };
  const hits = await recall({ query: "anything", k: 5, _deps: deps([cand], memVec) });
  expect(hits.length).toBe(1);
  expect(hits[0]!.score).toBeGreaterThan(0);
});

test("recall opens a sealed RULE and scores via text overlap", async () => {
  const key = await derivePayloadKey(SIG_A);
  _setPayloadKeyForTest(key);
  const ruleBytes = new TextEncoder().encode(
    JSON.stringify({ ruleText: "always verify contract audits before integrating" }),
  );
  const cand = await sealedCandidate(key, KEY_RULE, ruleBytes, ENTITY_TYPE.RULE);
  const hits = await recall({
    query: "should I verify the contract audits first?",
    k: 5,
    _deps: deps([cand], memVec),
  });
  expect(hits.length).toBe(1);
  expect(hits[0]!.entityType).toBe("rule");
  expect(hits[0]!.score).toBeGreaterThan(0);
});

test("payload key resolves from CORTEX_USER_PRIVATE_KEY env (deterministic)", async () => {
  // Fresh fixed key → derives a non-null AES key by signing the derivation message.
  process.env.CORTEX_USER_PRIVATE_KEY =
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
  _resetPayloadKey();
  const k1 = await getPayloadKey();
  expect(k1).not.toBeNull();
  // Memoized: same instance back without re-deriving.
  expect(await getPayloadKey()).toBe(k1!);
});

test("payload key is null when no wallet material is present", async () => {
  _resetPayloadKey();
  expect(await getPayloadKey()).toBeNull();
});

test("singleton identity overrides env in payload-key", async () => {
  const { _setOwnerIdentityForTest, _resetOwnerIdentity } = await import(
    "../src/agent/owner-identity"
  );

  _resetPayloadKey();
  _resetOwnerIdentity();

  const sealedKey = await derivePayloadKey(SIG_B);
  _setOwnerIdentityForTest({
    ownerAddress: ("0x" + "ab".repeat(20)) as Hex,
    userSignature: SIG_B,
    payloadKey: sealedKey,
    source: "browser",
  });

  const k = await getPayloadKey();
  expect(k).toBe(sealedKey);

  _resetOwnerIdentity();
  _resetPayloadKey();
});
