/**
 * Cortex — Document Tier tests.
 *
 * Proves: (1) the CBOR dual-payload codec round-trips full text + embedding
 * losslessly (embedding within f16 tolerance); (2) recall surfaces a document
 * candidate as a `document` hit and returns the REAL recovered text (the
 * sovereignty payoff) with a sensible full-precision rerank score.
 */

import { test, expect } from "bun:test";
import {
  encodeDocumentPayload,
  decodeDocumentPayload,
  isDocumentPayload,
} from "../src/compression/document-payload.ts";
import { recall, _resetLastRecallIds, type RecallCandidate } from "../src/darwinian/recall.ts";

const DIM = 1536;

/** Deterministic pseudo-random 1536-d unit-ish vector. */
function makeEmbedding(seed: number): Float32Array {
  const v = new Float32Array(DIM);
  let s = seed >>> 0;
  for (let i = 0; i < DIM; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    v[i] = (s / 0xffffffff) * 2 - 1; // [-1, 1]
  }
  return v;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

test("codec round-trips full text + embedding (f16 tolerance) + sections + metadata", () => {
  const text = "# Cortex\n\nSovereign memory on Arkiv. The full note survives a laptop death.";
  const embedding = makeEmbedding(42);
  const sections = [
    { heading: "Cortex", offset: 0, embedding: makeEmbedding(7) },
    { heading: "Recovery", offset: 30, embedding: makeEmbedding(9) },
  ];

  const bytes = encodeDocumentPayload({
    text,
    embedding,
    sections,
    title: "Cortex",
    vaultPath: "work/Cortex.md",
    frontmatter: { type: "project", tags: ["cortex", "arkiv"] },
    contentSha256: "abc123",
  });

  expect(bytes).toBeInstanceOf(Uint8Array);
  expect(isDocumentPayload(bytes)).toBe(true);

  const doc = decodeDocumentPayload(bytes);
  expect(doc.v).toBe(1);
  expect(doc.text).toBe(text); // LOSSLESS — the whole point
  expect(doc.code.length).toBe(198); // packed 1-bit RaBitQ
  expect(doc.rerankEmbedding.length).toBe(DIM);
  // f16 is lossy but should preserve direction near-perfectly.
  expect(cosine(embedding, doc.rerankEmbedding)).toBeGreaterThan(0.999);
  expect(doc.sections.length).toBe(2);
  expect(doc.sections[0]!.heading).toBe("Cortex");
  expect(doc.sections[1]!.offset).toBe(30);
  expect(doc.title).toBe("Cortex");
  expect(doc.vaultPath).toBe("work/Cortex.md");
  expect(doc.frontmatter).toEqual({ type: "project", tags: ["cortex", "arkiv"] });
  expect(doc.contentSha256).toBe("abc123");
});

test("recall surfaces a document hit and returns the recovered TEXT (not a fingerprint)", async () => {
  _resetLastRecallIds();
  const text = "Permissioned x402 router batches claims with Permit2 for gas efficiency.";
  const embedding = makeEmbedding(123);

  // Plaintext CBOR candidate (contentType != sealed → recall decodes directly,
  // exercising the document branch without needing a wallet key).
  const payload = encodeDocumentPayload({ text, embedding, contentSha256: "deadbeef" });
  const candidate: RecallCandidate = {
    key: "0xdoc0000000000000000000000000000000000000000000000000000000000001",
    payload,
    attributes: [{ key: "entityType", value: "document" }],
    expiresAtBlock: 999999n,
    contentType: "application/cbor",
  };

  const hits = await recall({
    query: "how does x402 routing work",
    k: 5,
    _deps: {
      fetchCandidates: async () => [candidate],
      embedQuery: async () => embedding, // query == doc embedding → cosine ≈ 1
      loadWeights: async () => new Map(), // avoid touching the real mirror
    },
  });

  expect(hits.length).toBe(1);
  const h = hits[0]!;
  expect(h.entityType).toBe("document");
  expect(h.text).toBe(text); // the lossless recovered note
  expect(h.payloadPreview).toContain("x402"); // preview is the real text, not hex
  expect(h.score).toBeGreaterThan(0.9); // full-precision rerank, query == doc
});
