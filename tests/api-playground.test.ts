/**
 * Cortex — Playground API handler unit tests.
 *
 * Pure in-memory: no Cohere, no Arkiv, no SQLite. Both handlers expose a
 * `deps` seam so we can substitute embedText / recall with deterministic
 * mocks. The real rabitqEncode / packCode pipeline still runs for the encode
 * path — we want to verify the byte layout, not re-mock the compressor.
 */

import { test, expect, describe } from "bun:test";
import {
  handlePlaygroundEncode,
  handlePlaygroundRecall,
  type PlaygroundEncodeResponse,
  type PlaygroundRecallResponse,
} from "../src/api/playground";
import type { MemoryHit } from "../src/darwinian/recall";

const EMBED_DIM = 1536;
const PACK_BYTES = 198;
const RAW_BYTES = EMBED_DIM * 4;

// ---------------------------------------------------------------------------
// Deterministic embedding mock — LCG + Box–Muller. Matches the pattern used
// in tests/rabitq.test.ts so the numbers are reproducible across runs.
// ---------------------------------------------------------------------------

function makeLcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function fixedEmbedding(seed: number): Float32Array {
  const rng = makeLcg(seed);
  const out = new Float32Array(EMBED_DIM);
  for (let i = 0; i < EMBED_DIM; i += 2) {
    let u1 = rng();
    const u2 = rng();
    if (u1 < 1e-12) u1 = 1e-12;
    const r = Math.sqrt(-2 * Math.log(u1));
    const theta = 2 * Math.PI * u2;
    out[i] = r * Math.cos(theta);
    if (i + 1 < EMBED_DIM) out[i + 1] = r * Math.sin(theta);
  }
  return out;
}

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/playground/encode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Encode handler
// ---------------------------------------------------------------------------

describe("handlePlaygroundEncode", () => {
  test("happy path: returns the full diagnostic shape", async () => {
    const fakeEmbed = async (text: string) => {
      // Hash the text into a seed so different inputs produce different vecs.
      let h = 0;
      for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
      return fixedEmbedding(h || 1);
    };

    const res = await handlePlaygroundEncode(
      makeRequest({ text: "hello world" }),
      { embedText: fakeEmbed },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as PlaygroundEncodeResponse;

    expect(body.packLength).toBe(PACK_BYTES);
    expect(body.rawEmbeddingLen).toBe(RAW_BYTES);
    expect(body.rawFirstBytes).toMatch(/^0x[0-9a-f]{64}$/);
    expect(body.packedBytes).toMatch(/^0x[0-9a-f]{396}$/); // 198 bytes = 396 hex
    expect(body.encodeTimeMs).toBeGreaterThan(0);
    expect(body.compressionRatio).toBeCloseTo(RAW_BYTES / PACK_BYTES, 3);
    // Random Gaussian input → norm > 0, align > 0.
    expect(body.normFp16).toBeGreaterThan(0);
    expect(body.alignFp16).toBeGreaterThan(0);
    // Self-IP for a Gaussian vector ≈ ‖vec‖² (large for raw Gaussian, not 1).
    // Just verify it's a finite positive number — the math correctness is
    // covered by tests/rabitq.test.ts already.
    expect(Number.isFinite(body.selfInnerProduct)).toBe(true);
    expect(body.selfInnerProduct).toBeGreaterThan(0);
  });

  test("rejects empty text with 400", async () => {
    const res = await handlePlaygroundEncode(makeRequest({ text: "" }), {
      embedText: async () => fixedEmbedding(1),
    });
    expect(res.status).toBe(400);
  });

  test("rejects missing text field with 400", async () => {
    const res = await handlePlaygroundEncode(makeRequest({ foo: "bar" }), {
      embedText: async () => fixedEmbedding(1),
    });
    expect(res.status).toBe(400);
  });

  test("rejects non-JSON body with 400", async () => {
    const res = await handlePlaygroundEncode(makeRequest("not json{"), {
      embedText: async () => fixedEmbedding(1),
    });
    expect(res.status).toBe(400);
  });

  test("rejects oversized text with 400", async () => {
    const huge = "x".repeat(10_000);
    const res = await handlePlaygroundEncode(makeRequest({ text: huge }), {
      embedText: async () => fixedEmbedding(1),
    });
    expect(res.status).toBe(400);
  });

  test("non-POST returns 405", async () => {
    const req = new Request("http://localhost/api/playground/encode", {
      method: "GET",
    });
    const res = await handlePlaygroundEncode(req);
    expect(res.status).toBe(405);
  });

  test("upstream embed failure → 503", async () => {
    const res = await handlePlaygroundEncode(makeRequest({ text: "hi" }), {
      embedText: async () => {
        throw new Error("COHERE_API_KEY is not set");
      },
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("embedText failed");
  });

  test("wrong-length embedding → 500", async () => {
    const res = await handlePlaygroundEncode(makeRequest({ text: "hi" }), {
      embedText: async () => new Float32Array(128),
    });
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Recall handler
// ---------------------------------------------------------------------------

describe("handlePlaygroundRecall", () => {
  const fixedHits: MemoryHit[] = [
    {
      entityKey: "0xabc1230000000000000000000000000000000000000000000000000000000001",
      entityType: "observation",
      score: 0.92,
      expiresAtBlock: 1_234_567,
      payloadPreview: "user prefers SPF 50 sunscreen",
      attributes: [{ key: "entityType", value: "observation" }],
    },
    {
      entityKey: "0xabc1230000000000000000000000000000000000000000000000000000000002",
      entityType: "episode",
      score: 0.55,
      expiresAtBlock: 1_234_999,
      payloadPreview: "summer trip planning session",
      attributes: [{ key: "entityType", value: "episode" }],
    },
  ];

  test("happy path: wraps recall() output as { hits }", async () => {
    let capturedQuery = "";
    let capturedK: number | undefined;
    const mockRecall = (async (opts: { query: string; k?: number }) => {
      capturedQuery = opts.query;
      capturedK = opts.k;
      return fixedHits;
    }) as unknown as typeof import("../src/darwinian/recall").recall;

    const req = new Request("http://localhost/api/playground/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "sunscreen", k: 5 }),
    });
    const res = await handlePlaygroundRecall(req, { recall: mockRecall });
    expect(res.status).toBe(200);

    const body = (await res.json()) as PlaygroundRecallResponse;
    expect(body.hits).toHaveLength(2);
    expect(body.hits[0]!.entityKey).toBe(fixedHits[0]!.entityKey);
    expect(body.hits[0]!.score).toBeCloseTo(0.92, 4);
    expect(body.hits[1]!.entityType).toBe("episode");
    expect(capturedQuery).toBe("sunscreen");
    expect(capturedK).toBe(5);
  });

  test("default k = 5 when omitted", async () => {
    let capturedK: number | undefined;
    const mockRecall = (async (opts: { query: string; k?: number }) => {
      capturedK = opts.k;
      return [];
    }) as unknown as typeof import("../src/darwinian/recall").recall;

    const req = new Request("http://localhost/api/playground/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "anything" }),
    });
    await handlePlaygroundRecall(req, { recall: mockRecall });
    expect(capturedK).toBe(5);
  });

  test("rejects missing query with 400", async () => {
    const req = new Request("http://localhost/api/playground/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ k: 5 }),
    });
    const res = await handlePlaygroundRecall(req, {
      recall: (async () => []) as unknown as typeof import("../src/darwinian/recall").recall,
    });
    expect(res.status).toBe(400);
  });

  test("rejects empty query with 400", async () => {
    const req = new Request("http://localhost/api/playground/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "" }),
    });
    const res = await handlePlaygroundRecall(req, {
      recall: (async () => []) as unknown as typeof import("../src/darwinian/recall").recall,
    });
    expect(res.status).toBe(400);
  });

  test("rejects non-integer k with 400", async () => {
    const req = new Request("http://localhost/api/playground/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "x", k: 1.5 }),
    });
    const res = await handlePlaygroundRecall(req, {
      recall: (async () => []) as unknown as typeof import("../src/darwinian/recall").recall,
    });
    expect(res.status).toBe(400);
  });

  test("rejects bad entityType with 400", async () => {
    const req = new Request("http://localhost/api/playground/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "x", entityType: "garbage" }),
    });
    const res = await handlePlaygroundRecall(req, {
      recall: (async () => []) as unknown as typeof import("../src/darwinian/recall").recall,
    });
    expect(res.status).toBe(400);
  });

  test("rejects non-JSON body with 400", async () => {
    const req = new Request("http://localhost/api/playground/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{{{not json",
    });
    const res = await handlePlaygroundRecall(req, {
      recall: (async () => []) as unknown as typeof import("../src/darwinian/recall").recall,
    });
    expect(res.status).toBe(400);
  });

  test("non-POST returns 405", async () => {
    const req = new Request("http://localhost/api/playground/recall", {
      method: "GET",
    });
    const res = await handlePlaygroundRecall(req);
    expect(res.status).toBe(405);
  });

  test("recall() throwing → 503 with helpful message", async () => {
    const mockRecall = (async () => {
      throw new Error("COHERE_API_KEY is not set");
    }) as unknown as typeof import("../src/darwinian/recall").recall;

    const req = new Request("http://localhost/api/playground/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "anything" }),
    });
    const res = await handlePlaygroundRecall(req, { recall: mockRecall });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("recall failed");
  });

  test("empty hits → 200 with empty array (no-results state)", async () => {
    const req = new Request("http://localhost/api/playground/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "anything" }),
    });
    const res = await handlePlaygroundRecall(req, {
      recall: (async () => []) as unknown as typeof import("../src/darwinian/recall").recall,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PlaygroundRecallResponse;
    expect(body.hits).toEqual([]);
  });
});
