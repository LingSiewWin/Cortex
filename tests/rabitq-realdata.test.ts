/**
 * Cortex — RaBitQ real-data integration tests.
 *
 * Unlike `tests/rabitq.test.ts` (synthetic Gaussian vectors), this suite drives
 * the encoder with REAL embeddings from a real embedding API (Cohere via the
 * existing `embedText` helper) and verifies SEMANTIC properties:
 *
 *   1. Pack format invariant — 198 bytes, deterministic
 *   2. Self-recall — every sentence scores > 0.85 against its own code
 *   3. Cluster gap — intra-cluster mean > inter-cluster mean + 0.10 for ≥ 9/12
 *   4. Recall@3 — query "cats and kittens" pulls all three Pets sentences
 *   5. Estimator fidelity — |raw_cosine - rabitq_estimate| < 0.20
 *   6. Encode latency — each rabitqEncode + packCode < 50 ms
 *
 * All tests skip cleanly when no embedding API key is configured, so CI without
 * network credentials still passes. When the key IS set the suite writes
 * `tests/fixtures/rabitq-realdata-report.json` — committed evidence that the
 * compressor was exercised against real Cohere embeddings.
 *
 * Cost note: one run = 13 Cohere embed calls (~$0.001 in API credit).
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import {
  packCode,
  rabitqEncode,
  rabitqInnerProduct,
  type RaBitQCode,
} from "../src/compression/rabitq.ts";
import { embedText } from "../src/compression/embeddings.ts";

// -----------------------------------------------------------------------------
// Skip gate — both Cohere and OpenAI tolerated; the helper currently uses
// Cohere, but we keep OpenAI in the gate so a future fallback wires up cleanly.
// -----------------------------------------------------------------------------

const HAS_COHERE = Boolean(process.env["COHERE_API_KEY"]);
const HAS_OPENAI = Boolean(process.env["OPENAI_API_KEY"]);
const HAS_KEY = HAS_COHERE || HAS_OPENAI;
const PROVIDER: "cohere" | "openai" | null = HAS_COHERE
  ? "cohere"
  : HAS_OPENAI
    ? "openai"
    : null;

if (!HAS_KEY) {
  // Visible signal that the suite is being skipped intentionally. `test.skipIf`
  // already shorts each test, but this line surfaces in `bun test` output so a
  // reader knows WHY nothing ran.
  // eslint-disable-next-line no-console
  console.warn(
    "[rabitq-realdata] No COHERE_API_KEY or OPENAI_API_KEY — skipping real-data tests.",
  );
}

// -----------------------------------------------------------------------------
// Corpus — 12 sentences in 4 thematic clusters of 3.
// -----------------------------------------------------------------------------

interface CorpusItem {
  text: string;
  cluster: "pets" | "defi" | "cooking" | "travel";
}

const CORPUS: readonly CorpusItem[] = [
  // Pets
  { text: "the cat sat on the mat", cluster: "pets" },
  { text: "feline rested on rug", cluster: "pets" },
  { text: "kittens love warm sunshine", cluster: "pets" },
  // DeFi
  { text: "Ethereum gas optimization techniques", cluster: "defi" },
  { text: "uniswap v4 hooks", cluster: "defi" },
  { text: "arbitrage in AMM pools", cluster: "defi" },
  // Cooking
  { text: "perfect pasta carbonara recipe", cluster: "cooking" },
  { text: "sourdough starter maintenance", cluster: "cooking" },
  { text: "kitchen knife sharpening", cluster: "cooking" },
  // Travel
  { text: "best ramen shops in Tokyo", cluster: "travel" },
  { text: "hiking trails in Patagonia", cluster: "travel" },
  { text: "budget hostels in Lisbon", cluster: "travel" },
];

const QUERY_TEXT = "cats and kittens";
const QUERY_EXPECTED_CLUSTER: CorpusItem["cluster"] = "pets";

// -----------------------------------------------------------------------------
// Shared state populated by beforeAll. Tests reference these by index.
// -----------------------------------------------------------------------------

interface EncodedItem {
  text: string;
  cluster: CorpusItem["cluster"];
  raw: Float32Array;
  code: RaBitQCode;
  packed: Uint8Array;
  encodeMs: number;
}

const items: EncodedItem[] = [];
let queryRaw: Float32Array | null = null;
let embedDim = 0;

// Report fields gathered during tests, flushed in afterAll.
const report: {
  generatedAt: string;
  provider: "cohere" | "openai" | null;
  corpusSize: number;
  embedDim: number;
  packBytes: number;
  selfRecallScores: number[];
  intraClusterMean: number;
  interClusterMean: number;
  cluster_gap_pass_count: number;
  recall3OnQuery: { query: string; topKeys: string[] };
  estimatorError: { rawCosine: number; rabitqEstimate: number; abs: number };
  encodeTimesMs: number[];
} = {
  generatedAt: "",
  provider: PROVIDER,
  corpusSize: CORPUS.length,
  embedDim: 0,
  packBytes: 0,
  selfRecallScores: [],
  intraClusterMean: 0,
  interClusterMean: 0,
  cluster_gap_pass_count: 0,
  recall3OnQuery: { query: QUERY_TEXT, topKeys: [] },
  estimatorError: { rawCosine: 0, rabitqEstimate: 0, abs: 0 },
  encodeTimesMs: [],
};

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function round(x: number, digits = 4): number {
  const k = 10 ** digits;
  return Math.round(x * k) / k;
}

// Estimator output is an unbiased estimate of ⟨vec, query⟩ — i.e. on raw
// (un-normalized) embedding inputs. To compare to cosine we divide by the
// product of raw L2 norms. This mirrors the math in src/compression/rabitq.ts
// and the explainer in docs/RabitQ.md §2.
function rabitqCosine(
  query: Float32Array,
  queryRawForNorm: Float32Array,
  code: RaBitQCode,
  vecRaw: Float32Array,
): number {
  const ip = rabitqInnerProduct(query, code);
  let qn = 0;
  for (let i = 0; i < queryRawForNorm.length; i++) {
    const v = queryRawForNorm[i]!;
    qn += v * v;
  }
  let vn = 0;
  for (let i = 0; i < vecRaw.length; i++) {
    const v = vecRaw[i]!;
    vn += v * v;
  }
  if (qn === 0 || vn === 0) return 0;
  return ip / (Math.sqrt(qn) * Math.sqrt(vn));
}

// -----------------------------------------------------------------------------
// Setup — embed + encode once.
// -----------------------------------------------------------------------------

beforeAll(async () => {
  if (!HAS_KEY) return;

  // Embed all 12 corpus sentences + the query in series. Cohere's free tier
  // throttles concurrent embed calls, so a tight loop is safer than Promise.all.
  for (const item of CORPUS) {
    const raw = await embedText(item.text);
    if (embedDim === 0) embedDim = raw.length;

    const t0 = performance.now();
    const code = rabitqEncode(raw);
    const packed = packCode(code);
    const t1 = performance.now();

    items.push({
      text: item.text,
      cluster: item.cluster,
      raw,
      code,
      packed,
      encodeMs: t1 - t0,
    });
  }

  queryRaw = await embedText(QUERY_TEXT);
}, 120_000); // 2 minute timeout — 13 sequential API calls.

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

test.skipIf(!HAS_KEY)(
  "real-data: pack format invariant (198 bytes, deterministic)",
  () => {
    expect(items.length).toBe(CORPUS.length);
    for (const it of items) {
      expect(it.packed.length).toBe(198);
      // Re-encode the same raw embedding — bytes must be identical.
      const repacked = packCode(rabitqEncode(it.raw));
      expect(repacked.length).toBe(198);
      for (let i = 0; i < 198; i++) {
        expect(repacked[i]).toBe(it.packed[i]!);
      }
    }
  },
);

test.skipIf(!HAS_KEY)(
  "real-data: self-recall > 0.85 for every sentence",
  () => {
    const scores: number[] = [];
    for (const it of items) {
      const score = rabitqCosine(it.raw, it.raw, it.code, it.raw);
      scores.push(score);
      expect(score).toBeGreaterThan(0.85);
    }
    report.selfRecallScores = scores.map((s) => round(s));
  },
);

test.skipIf(!HAS_KEY)(
  "real-data: intra-cluster mean exceeds inter-cluster mean by 0.10 for ≥ 9/12",
  () => {
    let passCount = 0;
    const intraAll: number[] = [];
    const interAll: number[] = [];

    for (let i = 0; i < items.length; i++) {
      const me = items[i]!;
      const intra: number[] = [];
      const inter: number[] = [];
      for (let j = 0; j < items.length; j++) {
        if (i === j) continue;
        const other = items[j]!;
        const score = rabitqCosine(me.raw, me.raw, other.code, other.raw);
        if (other.cluster === me.cluster) intra.push(score);
        else inter.push(score);
      }
      const mIntra = mean(intra);
      const mInter = mean(inter);
      intraAll.push(...intra);
      interAll.push(...inter);
      if (mIntra > mInter + 0.1) passCount++;
    }

    report.intraClusterMean = round(mean(intraAll));
    report.interClusterMean = round(mean(interAll));
    report.cluster_gap_pass_count = passCount;

    expect(passCount).toBeGreaterThanOrEqual(9);
  },
);

test.skipIf(!HAS_KEY)("real-data: recall@3 on query 'cats and kittens'", () => {
  expect(queryRaw).not.toBeNull();
  const q = queryRaw!;

  const scored = items.map((it) => ({
    text: it.text,
    cluster: it.cluster,
    score: rabitqCosine(q, q, it.code, it.raw),
  }));
  scored.sort((a, b) => b.score - a.score);

  const top3 = scored.slice(0, 3);
  report.recall3OnQuery.topKeys = top3.map((t) => t.text);

  for (const hit of top3) {
    expect(hit.cluster).toBe(QUERY_EXPECTED_CLUSTER);
  }
});

test.skipIf(!HAS_KEY)(
  "real-data: estimator vs raw cosine within 0.20 absolute",
  () => {
    // Pick two clearly-related sentences (same cluster) so cosine is non-trivial.
    const a = items[0]!; // "the cat sat on the mat"
    const b = items[1]!; // "feline rested on rug"

    const rawCos = cosine(a.raw, b.raw);
    const est = rabitqCosine(a.raw, a.raw, b.code, b.raw);
    const abs = Math.abs(rawCos - est);

    report.estimatorError = {
      rawCosine: round(rawCos),
      rabitqEstimate: round(est),
      abs: round(abs),
    };

    expect(abs).toBeLessThan(0.2);
  },
);

test.skipIf(!HAS_KEY)("real-data: per-encode latency < 50 ms", () => {
  const times = items.map((it) => it.encodeMs);
  report.encodeTimesMs = times.map((t) => round(t, 3));
  for (const t of times) {
    expect(t).toBeLessThan(50);
  }
});

// -----------------------------------------------------------------------------
// Report writer — committed evidence that the suite ran on real data.
// -----------------------------------------------------------------------------

afterAll(async () => {
  if (!HAS_KEY) return;

  report.generatedAt = new Date().toISOString();
  report.embedDim = embedDim;
  report.packBytes = items[0]?.packed.length ?? 0;

  const out = JSON.stringify(report, null, 2) + "\n";
  await Bun.write("tests/fixtures/rabitq-realdata-report.json", out);
});
