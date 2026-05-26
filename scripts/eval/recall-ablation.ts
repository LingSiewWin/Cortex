/**
 * Cortex — B4: SEDM-weighted vs flat recall ablation (offline, REAL embeddings).
 *
 * Question: does fusing the evolved SEDM utility weight into recall retrieve
 * genuinely-useful memories better than embedding similarity alone?
 *
 * Honesty safeguards (per IR-eval best practice):
 *   - REAL corpus: every memory is verbatim text from /docs (scripts/eval/recall-corpus.json),
 *     embedded with the REAL provider (OpenRouter text-embedding-3-small, 1536-d).
 *   - REAL ship regime: memories are RaBitQ 1-bit quantized (198 B); we score the
 *     full-precision query against the quantized code, exactly as production recall does.
 *   - Hard negatives: each query's distractors are same-topic doc passages that share
 *     vocabulary with the gold — similarity alone struggles to separate them. We report
 *     the gold−distractor similarity gap (Δ) so reviewers see the test is non-trivial.
 *   - No oracle / no leakage: "true usefulness" u* (gold-ness) is hidden from the weight
 *     mechanism. The weight evolves ONLY from a NOISY, sparse proxy of u* (simulated
 *     citation outcomes corrupted by Gaussian noise + a distractor false-positive rate),
 *     run through the REAL evolveWeight/proxyUtility pipeline (src/darwinian/utility.ts).
 *   - We lead with nDCG@k (a reranking metric), corroborate with recall@k + MRR, and
 *     report a paired bootstrap CI over queries + a noise-sensitivity sweep so the lift
 *     degrades honestly as the proxy gets noisier (an oracle would not).
 *
 * Run: bun scripts/eval/recall-ablation.ts   (needs OPENROUTER_API_KEY in .env)
 */

import type { Hex } from "@arkiv-network/sdk";
import { embedText } from "../../src/compression/embeddings.ts";
import { rabitqEncode, packCode } from "../../src/compression/rabitq.ts";
import { recall, type RecallCandidate } from "../../src/darwinian/recall.ts";
import { proxyUtility, evolveWeight } from "../../src/darwinian/utility.ts";
import { ENTITY_TYPE, UTILITY } from "../../src/constants.ts";

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

interface Topic {
  id: string;
  query: string;
  gold: string;
  gold_source: string;
  distractors: string[];
}
interface Corpus {
  topics: Topic[];
}

interface Memory {
  key: Hex;
  topicId: string;
  text: string;
  isGold: boolean;
  embedding: Float32Array;
  packed: Uint8Array;
}

const CORPUS_URL = new URL("./recall-corpus.json", import.meta.url);
const CACHE_URL = new URL("./.embed-cache.json", import.meta.url);

function synthKey(i: number): Hex {
  return ("0x" + i.toString(16).padStart(64, "0")) as Hex;
}

/** Deterministic small hash for the embedding cache key. */
function hashText(t: string): string {
  let h = 5381;
  for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16) + ":" + t.length;
}

async function loadEmbedCache(): Promise<Record<string, number[]>> {
  try {
    return JSON.parse(await Bun.file(CACHE_URL).text()) as Record<string, number[]>;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/** 1-based rank of `goldKey` in a score-sorted candidate list; Infinity if absent. */
function rankOfGold(ranked: { key: Hex }[], goldKey: Hex): number {
  const idx = ranked.findIndex((r) => r.key === goldKey);
  return idx === -1 ? Infinity : idx + 1;
}
function recallAtK(rank: number, k: number): number {
  return rank <= k ? 1 : 0;
}
function reciprocalRank(rank: number): number {
  return Number.isFinite(rank) ? 1 / rank : 0;
}
/** Binary-relevance nDCG@k with a single relevant item: 1/log2(rank+1) if rank<=k. */
function ndcgAtK(rank: number, k: number): number {
  if (rank > k) return 0;
  return 1 / Math.log2(rank + 1); // IDCG = 1/log2(2) = 1
}
function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Cosine over full-precision embeddings (for the RaBitQ-fidelity baseline). */
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// ---------------------------------------------------------------------------
// Weight simulation — the honest, noisy proxy of hidden usefulness
// ---------------------------------------------------------------------------

/** Mulberry32 — deterministic PRNG so a seed fully reproduces a run. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Box-Muller standard normal. */
function gauss(r: () => number): number {
  const u = Math.max(1e-9, r()),
    v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

interface SimParams {
  seed: number;
  rounds: number;
  pGoldCite: number; // P(cite | gold) per round
  pDistCite: number; // P(cite | distractor) per round — the false-positive rate
  outcomeNoise: number; // σ of Gaussian noise on the observed outcome signal
}

/**
 * Evolve each memory's weight from a simulated usage history. The weight
 * mechanism NEVER sees u* (gold-ness) directly — only noisy citation events:
 *   - a memory is cited this round with prob pGoldCite (gold) / pDistCite (distractor)
 *   - on citation, the observed outcome = clamp(u* + N(0, outcomeNoise))
 *   - weight updates via the REAL proxyUtility + evolveWeight (utility.ts)
 * The metabolic −β·fUse term means a distractor cited with low outcome LOSES weight,
 * which is exactly how SEDM separates useful from merely-frequent.
 */
function simulateWeights(memories: Memory[], p: SimParams): Map<Hex, number> {
  const r = rng(p.seed);
  const weights = new Map<Hex, number>();
  const lastCitedMs = new Map<Hex, number>();
  for (const m of memories) weights.set(m.key, UTILITY.wInit);

  let clockMs = 0;
  const stepMs = 30 * 60 * 1000; // 30 min between rounds (recency realism)
  for (let round = 0; round < p.rounds; round++) {
    clockMs += stepMs;
    for (const m of memories) {
      const pCite = m.isGold ? p.pGoldCite : p.pDistCite;
      if (r() >= pCite) continue; // not cited this round

      const uStar = m.isGold ? 1 : 0;
      const outcome = Math.max(0, Math.min(1, uStar + gauss(r) * p.outcomeNoise));
      const last = lastCitedMs.get(m.key);
      const msSince = last === undefined ? Infinity : clockMs - last;
      lastCitedMs.set(m.key, clockMs);

      const uHat = proxyUtility({
        msSinceLastCite: msSince,
        citationCount: 1,
        rank: 0, // a deliberate use; rank evidence decoupled from the eval recaller
        k: 5,
        outcome,
      });
      weights.set(m.key, evolveWeight(weights.get(m.key)!, uHat, 1));
    }
  }
  return weights;
}

// ---------------------------------------------------------------------------
// Recall variants (identical except the weight fusion)
// ---------------------------------------------------------------------------

async function rankFor(
  queryEmbedding: Float32Array,
  candidates: RecallCandidate[],
  weights: Map<Hex, number> | null, // null ⇒ FLAT (all wInit ⇒ factor 1.0)
): Promise<{ key: Hex; score: number }[]> {
  const hits = await recall({
    query: "x", // ignored — embedQuery is injected
    k: candidates.length,
    _deps: {
      fetchCandidates: async () => candidates,
      embedQuery: async () => queryEmbedding,
      loadWeights: async (keys: Hex[]) => {
        const m = new Map<Hex, number>();
        if (weights) for (const k of keys) m.set(k, weights.get(k) ?? UTILITY.wInit);
        return m; // empty ⇒ recall defaults to wInit ⇒ factor 1.0 (flat)
      },
    },
  });
  return hits.map((h) => ({ key: h.entityKey, score: h.score }));
}

/** Full-precision cosine ranking (RaBitQ-fidelity baseline — no quantization). */
function rankFullPrecision(
  queryEmbedding: Float32Array,
  memories: Memory[],
): { key: Hex; score: number }[] {
  return memories
    .map((m) => ({ key: m.key, score: cosine(queryEmbedding, m.embedding) }))
    .sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const K_GRID = [1, 3, 5] as const;

async function main(): Promise<void> {
  const corpus = JSON.parse(await Bun.file(CORPUS_URL).text()) as Corpus;
  console.log(`\n=== B4: SEDM-weighted vs flat recall ablation ===`);
  console.log(`corpus: ${corpus.topics.length} topics (real /docs passages)\n`);

  // 1. Build the memory set + embed everything (real provider, cached).
  const cache = await loadEmbedCache();
  const memories: Memory[] = [];
  const queries: { topicId: string; text: string; embedding: Float32Array; goldKey: Hex }[] = [];
  let idx = 0;
  let apiCalls = 0;

  async function embedCached(text: string): Promise<Float32Array> {
    const h = hashText(text);
    if (cache[h]) return new Float32Array(cache[h]!);
    apiCalls++;
    const e = await embedText(text);
    cache[h] = Array.from(e);
    return e;
  }

  for (const t of corpus.topics) {
    const goldKey = synthKey(idx++);
    const goldEmb = await embedCached(t.gold);
    memories.push({
      key: goldKey,
      topicId: t.id,
      text: t.gold,
      isGold: true,
      embedding: goldEmb,
      packed: packCode(rabitqEncode(goldEmb)),
    });
    for (const d of t.distractors) {
      const dEmb = await embedCached(d);
      memories.push({
        key: synthKey(idx++),
        topicId: t.id,
        text: d,
        isGold: false,
        embedding: dEmb,
        packed: packCode(rabitqEncode(dEmb)),
      });
    }
    const qEmb = await embedCached(t.query);
    queries.push({ topicId: t.id, text: t.query, embedding: qEmb, goldKey });
  }
  await Bun.write(CACHE_URL, JSON.stringify(cache));
  console.log(
    `embedded ${memories.length} memories + ${queries.length} queries ` +
      `(${apiCalls} live API calls, rest cached)\n`,
  );

  // Candidates for recall() — RaBitQ-quantized payloads (the real ship regime).
  const candidates: RecallCandidate[] = memories.map((m) => ({
    key: m.key,
    payload: m.packed,
    attributes: [{ key: "entityType", value: ENTITY_TYPE.OBSERVATION }],
    expiresAtBlock: 999_999n,
    contentType: null,
  }));

  // 2. Difficulty diagnostic — gold vs best-distractor RaBitQ-IP gap under FLAT.
  //    If Δ is ~0 or negative, similarity alone cannot separate gold ⇒ hard test.
  const deltas: number[] = [];
  for (const q of queries) {
    const ranked = await rankFor(q.embedding, candidates, null);
    const scoreByKey = new Map(ranked.map((r) => [r.key, r.score]));
    const goldScore = scoreByKey.get(q.goldKey) ?? 0;
    const distractorScores = memories
      .filter((m) => m.topicId === q.topicId && !m.isGold)
      .map((m) => scoreByKey.get(m.key) ?? 0);
    deltas.push(goldScore - Math.max(...distractorScores));
  }
  console.log(`difficulty: mean gold−bestDistractor similarity gap Δ = ${mean(deltas).toFixed(4)}`);
  console.log(
    `  (Δ≤0 means similarity can't separate gold from same-topic distractors — the hard regime)\n`,
  );

  // 3. RaBitQ fidelity (no simulation): full-precision cosine vs 1-bit recall@k.
  console.log(`--- RaBitQ compression fidelity (full-precision cosine vs 1-bit quantized) ---`);
  for (const k of K_GRID) {
    const fp: number[] = [];
    const rq: number[] = [];
    for (const q of queries) {
      fp.push(recallAtK(rankOfGold(rankFullPrecision(q.embedding, memories), q.goldKey), k));
      rq.push(recallAtK(rankOfGold(await rankFor(q.embedding, candidates, null), q.goldKey), k));
    }
    console.log(
      `  recall@${k}:  full-precision ${(mean(fp) * 100).toFixed(1)}%   ` +
        `RaBitQ-1bit ${(mean(rq) * 100).toFixed(1)}%`,
    );
  }
  console.log("");

  // 4. The ablation — FLAT vs WEIGHTED, averaged over seeds.
  const baseParams: Omit<SimParams, "seed"> = {
    rounds: 40,
    pGoldCite: 0.6, // gold gets used often...
    pDistCite: 0.2, // ...but distractors are sometimes cited too (false positives)
    outcomeNoise: 0.25, // the outcome signal is a NOISY proxy of true usefulness
  };
  const SEEDS = [1, 2, 3, 4, 5];

  // Per-query nDCG@5 for the paired bootstrap (averaged over seeds per query).
  const perQueryFlat: number[] = new Array(queries.length).fill(0);
  const perQueryWeighted: number[] = new Array(queries.length).fill(0);

  const agg: Record<string, { flat: number[]; weighted: number[] }> = {};
  for (const k of K_GRID) agg[`recall@${k}`] = { flat: [], weighted: [] };
  agg["MRR"] = { flat: [], weighted: [] };
  agg["nDCG@5"] = { flat: [], weighted: [] };

  for (const seed of SEEDS) {
    const weights = simulateWeights(memories, { ...baseParams, seed });
    for (let qi = 0; qi < queries.length; qi++) {
      const q = queries[qi]!;
      const flatRank = rankOfGold(await rankFor(q.embedding, candidates, null), q.goldKey);
      const wRank = rankOfGold(await rankFor(q.embedding, candidates, weights), q.goldKey);
      for (const k of K_GRID) {
        agg[`recall@${k}`]!.flat.push(recallAtK(flatRank, k));
        agg[`recall@${k}`]!.weighted.push(recallAtK(wRank, k));
      }
      agg["MRR"]!.flat.push(reciprocalRank(flatRank));
      agg["MRR"]!.weighted.push(reciprocalRank(wRank));
      const fN = ndcgAtK(flatRank, 5);
      const wN = ndcgAtK(wRank, 5);
      agg["nDCG@5"]!.flat.push(fN);
      agg["nDCG@5"]!.weighted.push(wN);
      perQueryFlat[qi]! += fN / SEEDS.length;
      perQueryWeighted[qi]! += wN / SEEDS.length;
    }
  }

  console.log(
    `--- Ablation: flat (similarity only) vs SEDM-weighted ` +
      `[${SEEDS.length} seeds × ${queries.length} queries; rounds=${baseParams.rounds}, ` +
      `pGold=${baseParams.pGoldCite}, pDist=${baseParams.pDistCite}, noise=${baseParams.outcomeNoise}] ---`,
  );
  for (const metric of Object.keys(agg)) {
    const f = mean(agg[metric]!.flat);
    const w = mean(agg[metric]!.weighted);
    const lift = w - f;
    const pct = f > 0 ? ((lift / f) * 100).toFixed(1) : "∞";
    const fmt = (x: number) => (metric.startsWith("recall") ? (x * 100).toFixed(1) + "%" : x.toFixed(4));
    console.log(
      `  ${metric.padEnd(9)} flat ${fmt(f).padStart(8)}   weighted ${fmt(w).padStart(8)}   ` +
        `lift ${(lift >= 0 ? "+" : "") + fmt(lift)}  (${lift >= 0 ? "+" : ""}${pct}%)`,
    );
  }

  // 5. Paired bootstrap CI on per-query nDCG@5 difference (weighted − flat).
  const diffs = perQueryWeighted.map((w, i) => w - perQueryFlat[i]!);
  const wins = diffs.filter((d) => d > 1e-9).length;
  const losses = diffs.filter((d) => d < -1e-9).length;
  const ties = diffs.length - wins - losses;
  const br = rng(424242);
  const boots: number[] = [];
  for (let b = 0; b < 5000; b++) {
    let s = 0;
    for (let i = 0; i < diffs.length; i++) s += diffs[Math.floor(br() * diffs.length)]!;
    boots.push(s / diffs.length);
  }
  boots.sort((a, b) => a - b);
  const lo = boots[Math.floor(0.025 * boots.length)]!;
  const hi = boots[Math.floor(0.975 * boots.length)]!;
  console.log(
    `\n  per-query nDCG@5 Δ: mean ${mean(diffs).toFixed(4)}  ` +
      `95% bootstrap CI [${lo.toFixed(4)}, ${hi.toFixed(4)}]  ` +
      `(${wins} wins / ${ties} ties / ${losses} losses)`,
  );
  console.log(
    `  ${lo > 0 ? "✅ CI excludes 0 — weighting's nDCG@5 lift is significant on this corpus" : "⚠ CI includes 0 — not significant at this corpus size"}`,
  );

  // 6. Noise-sensitivity sweep — the anti-oracle proof. Lift should DECAY as the
  //    proxy gets noisier; a flat-large lift would betray leakage.
  console.log(`\n--- Noise sensitivity (nDCG@5 lift vs outcome-noise σ; an oracle would not decay) ---`);
  for (const noise of [0.0, 0.25, 0.5, 1.0, 2.0]) {
    const fs: number[] = [];
    const ws: number[] = [];
    for (const seed of SEEDS) {
      const weights = simulateWeights(memories, { ...baseParams, outcomeNoise: noise, seed });
      for (const q of queries) {
        fs.push(ndcgAtK(rankOfGold(await rankFor(q.embedding, candidates, null), q.goldKey), 5));
        ws.push(ndcgAtK(rankOfGold(await rankFor(q.embedding, candidates, weights), q.goldKey), 5));
      }
    }
    const lift = mean(ws) - mean(fs);
    console.log(
      `  σ=${noise.toFixed(2)}:  flat ${mean(fs).toFixed(4)}  weighted ${mean(ws).toFixed(4)}  ` +
        `lift ${(lift >= 0 ? "+" : "") + lift.toFixed(4)}`,
    );
  }

  // 7. Frequency-control sweep — the strictest honesty check. The weight consumes
  //    citation COUNT/recency, not just outcome, so part of the headline lift could
  //    be the tautology "gold is cited more (pGold=0.6 > pDist=0.2) ⇒ ranked higher."
  //    Here we raise pDist toward pGold so gold and distractors are cited EQUALLY
  //    often — the only remaining usefulness signal is the (noisy) outcome. If the
  //    lift survives at pGold=pDist, the win is genuine outcome-discrimination; if it
  //    collapses, frequency was doing the work. We report it either way.
  console.log(`\n--- Frequency control (raise pDist→pGold=${baseParams.pGoldCite}; isolates outcome signal from citation frequency) ---`);
  for (const pDist of [0.2, 0.3, 0.45, 0.6]) {
    const fs: number[] = [];
    const ws: number[] = [];
    for (const seed of SEEDS) {
      const weights = simulateWeights(memories, { ...baseParams, pDistCite: pDist, seed });
      for (const q of queries) {
        fs.push(ndcgAtK(rankOfGold(await rankFor(q.embedding, candidates, null), q.goldKey), 5));
        ws.push(ndcgAtK(rankOfGold(await rankFor(q.embedding, candidates, weights), q.goldKey), 5));
      }
    }
    const lift = mean(ws) - mean(fs);
    const tag = pDist === baseParams.pGoldCite ? " ← equal frequency (outcome-only signal)" : "";
    console.log(
      `  pDist=${pDist.toFixed(2)}:  flat ${mean(fs).toFixed(4)}  weighted ${mean(ws).toFixed(4)}  ` +
        `lift ${(lift >= 0 ? "+" : "") + lift.toFixed(4)}${tag}`,
    );
  }
  console.log("");
}

main().catch((err) => {
  console.error("ablation failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
