/**
 * Cortex — recall degrades gracefully when no embeddings key is configured.
 *
 * A fresh installer with no provider key must still get a useful plugin: recall
 * must NOT throw — it falls back to keyword/text-overlap scoring. Rules and
 * documents (which carry text) still recall; pure-vector observations can't be
 * keyword-matched and simply drop out. Verifies the MissingEmbeddingKeyError
 * catch in recall().
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Hex } from "@arkiv-network/sdk";
import { recall, _resetLastRecallIds, type RecallCandidate } from "../src/darwinian/recall.ts";
import { MissingEmbeddingKeyError } from "../src/compression/embeddings.ts";
import { rabitqEncode, packCode } from "../src/compression/rabitq.ts";
import { ENTITY_TYPE } from "../src/constants.ts";
import { _resetConfigCache } from "../src/lib/cortex-config.ts";
import { _resetPayloadKey } from "../src/lib/payload-key.ts";
import { _resetOwnerIdentity } from "../src/agent/owner-identity.ts";

let dir: string;
const SAVED_CONFIG_PATH = process.env.CORTEX_CONFIG_PATH;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cortex-nokey-"));
  process.env.CORTEX_CONFIG_PATH = join(dir, "config.json");
  _resetConfigCache();
  _resetOwnerIdentity();
  _resetPayloadKey();
  _resetLastRecallIds();
});
afterEach(() => {
  if (SAVED_CONFIG_PATH === undefined) delete process.env.CORTEX_CONFIG_PATH;
  else process.env.CORTEX_CONFIG_PATH = SAVED_CONFIG_PATH;
  rmSync(dir, { recursive: true, force: true });
  _resetConfigCache();
  _resetOwnerIdentity();
  _resetPayloadKey();
});

const KEY_RULE = "0x2222222222222222222222222222222222222222222222222222222222222222" as Hex;
const KEY_OBS = "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;

// An embed that behaves exactly like embedText with no provider key.
const noKeyEmbed = async (): Promise<Float32Array> => {
  throw new MissingEmbeddingKeyError("no embeddings key (test)");
};

function ruleCandidate(key: Hex, ruleText: string): RecallCandidate {
  return {
    key,
    payload: new TextEncoder().encode(JSON.stringify({ ruleText })),
    attributes: [{ key: "entityType", value: ENTITY_TYPE.RULE }],
    expiresAtBlock: 1_000_000n,
  };
}

function unitVector(seed: number): Float32Array {
  let s = seed >>> 0;
  const v = new Float32Array(1536);
  let norm = 0;
  for (let i = 0; i < 1536; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const x = s / 0x1_0000_0000 - 0.5;
    v[i] = x;
    norm += x * x;
  }
  const inv = 1 / Math.sqrt(norm);
  for (let i = 0; i < 1536; i++) v[i]! *= inv;
  return v;
}

const noKeyDeps = (cands: RecallCandidate[]) => ({
  embedQuery: noKeyEmbed,
  fetchCandidates: async () => cands,
  loadWeights: async () => new Map<Hex, number>(),
});

test("no embeddings key: recall does NOT throw and keyword-scores a matching rule", async () => {
  const cand = ruleCandidate(KEY_RULE, "Always use bun instead of npm for this repo");
  const hits = await recall({
    query: "should I use bun or npm to install",
    k: 5,
    _deps: noKeyDeps([cand]),
  });
  expect(hits.length).toBeGreaterThanOrEqual(1);
  expect(hits[0]!.entityKey).toBe(KEY_RULE);
  expect(hits[0]!.score).toBeGreaterThan(0);
});

test("no embeddings key: a non-matching rule scores 0 (no false positive, no throw)", async () => {
  const cand = ruleCandidate(KEY_RULE, "Deploy the frontend to Vercel on every push to main");
  const hits = await recall({
    query: "quantum chromodynamics lattice gauge theory",
    k: 5,
    _deps: noKeyDeps([cand]),
  });
  // recall returns top-k including zero-score hits; no keyword overlap → score 0.
  expect(hits.length).toBe(1);
  expect(hits[0]!.score).toBe(0);
});

test("no embeddings key: a pure-vector observation scores 0 (can't keyword-match), no throw", async () => {
  const obs: RecallCandidate = {
    key: KEY_OBS,
    payload: packCode(rabitqEncode(unitVector(7))),
    attributes: [{ key: "entityType", value: ENTITY_TYPE.OBSERVATION }],
    expiresAtBlock: 1_000_000n,
  };
  const hits = await recall({ query: "anything at all", k: 5, _deps: noKeyDeps([obs]) });
  // Present but unscorable without an embedding → score 0 (ranks last, agent ignores).
  expect(hits.length).toBe(1);
  expect(hits[0]!.score).toBe(0);
});
