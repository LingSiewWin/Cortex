/**
 * Cortex — hybrid recall tests.
 *
 * Proves provenance (the tabular layer) modulates RaBitQ vector recall:
 *   - same-project memories are BOOSTED (rank higher) — sharper on your work
 *   - same-session memories are BOOSTED — continuity
 *   - requireProject HARD-FILTERS other projects out
 *   - with no provenance opts, behaviour is unchanged (backwards-compatible)
 *
 * Uses the recall _deps seam (injected candidates + embedding) so nothing
 * touches Braga or an embedding provider.
 */

import { test, expect } from "bun:test";
import { recall, _resetLastRecallIds, type RecallCandidate } from "../src/darwinian/recall.ts";
import { encodeDocumentPayload } from "../src/compression/document-payload.ts";

const DIM = 1536;

function makeEmbedding(seed: number): Float32Array {
  const v = new Float32Array(DIM);
  let s = seed >>> 0;
  for (let i = 0; i < DIM; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    v[i] = (s / 0xffffffff) * 2 - 1;
  }
  return v;
}

/** A document candidate with the same embedding (→ same base score) + provenance. */
function docCandidate(
  key: string,
  embedding: Float32Array,
  attrs: { project?: string; sessionId?: string },
): RecallCandidate {
  const a: { key: string; value: string | number }[] = [
    { key: "entityType", value: "document" },
  ];
  // provenance lives under the "workspace" key (NOT "project" — that's the
  // reserved PROJECT_ATTRIBUTE namespace; see WORKSPACE_ATTR in constants).
  if (attrs.project) a.push({ key: "workspace", value: attrs.project });
  if (attrs.sessionId) a.push({ key: "sessionId", value: attrs.sessionId });
  return {
    key: key as `0x${string}`,
    payload: encodeDocumentPayload({ text: `note ${key}`, embedding, contentSha256: "x" }),
    attributes: a,
    expiresAtBlock: 999999n,
    contentType: "application/cbor",
  };
}

const KEY_A = "0xaaaa000000000000000000000000000000000000000000000000000000000001";
const KEY_B = "0xbbbb000000000000000000000000000000000000000000000000000000000002";

test("same-project memories are boosted above other-project ones", async () => {
  _resetLastRecallIds();
  const emb = makeEmbedding(1); // identical embedding → identical base score
  const hits = await recall({
    query: "anything",
    k: 5,
    project: "alpha",
    _deps: {
      embedQuery: async () => emb,
      loadWeights: async () => new Map(),
      fetchCandidates: async () => [
        docCandidate(KEY_B, emb, { project: "beta" }),
        docCandidate(KEY_A, emb, { project: "alpha" }),
      ],
    },
  });
  expect(hits.length).toBe(2);
  // Identical base score, but the alpha (matching) doc must rank first via boost.
  expect(hits[0]!.entityKey).toBe(KEY_A);
  expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
});

test("requireProject hard-filters other projects out", async () => {
  _resetLastRecallIds();
  const emb = makeEmbedding(2);
  const hits = await recall({
    query: "anything",
    k: 5,
    project: "alpha",
    requireProject: true,
    _deps: {
      embedQuery: async () => emb,
      loadWeights: async () => new Map(),
      fetchCandidates: async () => [
        docCandidate(KEY_A, emb, { project: "alpha" }),
        docCandidate(KEY_B, emb, { project: "beta" }),
      ],
    },
  });
  expect(hits.length).toBe(1);
  expect(hits[0]!.entityKey).toBe(KEY_A);
});

test("same-session memories are boosted (continuity)", async () => {
  _resetLastRecallIds();
  const emb = makeEmbedding(3);
  const hits = await recall({
    query: "anything",
    k: 5,
    sessionId: "sess-1",
    _deps: {
      embedQuery: async () => emb,
      loadWeights: async () => new Map(),
      fetchCandidates: async () => [
        docCandidate(KEY_B, emb, { sessionId: "sess-2" }),
        docCandidate(KEY_A, emb, { sessionId: "sess-1" }),
      ],
    },
  });
  expect(hits[0]!.entityKey).toBe(KEY_A);
});

test("no provenance opts → no boost (backwards-compatible)", async () => {
  _resetLastRecallIds();
  const emb = makeEmbedding(4);
  const hits = await recall({
    query: "anything",
    k: 5,
    _deps: {
      embedQuery: async () => emb,
      loadWeights: async () => new Map(),
      fetchCandidates: async () => [
        docCandidate(KEY_A, emb, { project: "alpha" }),
        docCandidate(KEY_B, emb, { project: "beta" }),
      ],
    },
  });
  // Identical base scores, no boost applied → equal scores.
  expect(hits.length).toBe(2);
  expect(hits[0]!.score).toBeCloseTo(hits[1]!.score, 5);
});
