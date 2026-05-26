/**
 * Cortex — OpenClaw memory-arkiv adapter tests (offline).
 *
 * Verifies the pure bodies of the plugin's memory_recall / memory_store tools
 * return the OpenClaw tool-result shape and map onto Cortex correctly. memory_store
 * writes to Arkiv (covered by scripts/openclaw-harness.ts on Braga); memory_recall
 * is tested via recall's injected candidate seam.
 */

import { test, expect, beforeEach } from "bun:test";
import type { Hex } from "@arkiv-network/sdk";
import { memoryRecall } from "../src/openclaw/adapter";
import { _resetLastRecallIds, type RecallCandidate } from "../src/darwinian/recall";
import { packCode, rabitqEncode } from "../src/compression/rabitq";
import { ENTITY_TYPE } from "../src/constants";

const EMBED_DIM = 1536;
const ENTITY = "0xabc0000000000000000000000000000000000000000000000000000000000001" as Hex;

function unitVector(seed: number): Float32Array {
  let s = seed >>> 0;
  const rng = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0), s / 0x1_0000_0000);
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

const vec = unitVector(7);
const packed = packCode(rabitqEncode(vec));

function depsWithHit() {
  const cand: RecallCandidate = {
    key: ENTITY,
    payload: packed, // plaintext (no contentType)
    attributes: [{ key: "entityType", value: ENTITY_TYPE.OBSERVATION }],
    expiresAtBlock: 1_000_000n,
  };
  return {
    fetchCandidates: async () => [cand],
    embedQuery: async () => vec,
    loadWeights: async () => new Map<Hex, number>(),
  };
}

beforeEach(() => {
  _resetLastRecallIds();
});

test("memory_recall returns OpenClaw tool-result shape and includes the hit", async () => {
  const res = await memoryRecall({ query: "anything", k: 5, _deps: depsWithHit() });
  expect(res).toHaveProperty("content");
  expect(res.content[0]!.type).toBe("text");
  expect(res.content[0]!.text).toContain(ENTITY);
  expect(res.content[0]!.text).toContain("observation");
});

test("memory_recall reports no memories cleanly when none match", async () => {
  const res = await memoryRecall({
    query: "nothing matches",
    k: 3,
    _deps: {
      fetchCandidates: async () => [],
      embedQuery: async () => vec,
      loadWeights: async () => new Map<Hex, number>(),
    },
  });
  expect(res.content[0]!.text).toContain("No relevant memories");
});
