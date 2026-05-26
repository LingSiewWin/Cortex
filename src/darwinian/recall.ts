/**
 * Cortex — recall (the agent's ONLY read path).
 *
 * Returns top-k memory hits matching a natural-language query. Hits are scored
 * via:
 *   - OBSERVATION / EPISODE: RaBitQ inner-product estimate against the query
 *     embedding (compressed payload — see compression/rabitq.ts).
 *   - RULE: lightweight token-overlap heuristic against the rule's plain-text
 *     payload, since rules are distilled summaries that aren't worth embedding
 *     at v1 scale.
 *
 * Why this is the only read path:
 *   - The act() validator rejects citations that aren't in the last recall's
 *     `lastRecallIds` set. That makes hallucinated citations free — they don't
 *     bump tier counts and they don't trigger spurious extends.
 *
 * Project hygiene:
 *   - Every query goes through `cortexQuery()`, which stamps PROJECT_ATTRIBUTE
 *     so we never read cross-project entities by accident.
 *   - We optionally narrow by `createdBy` for stricter trust (Section 12 of
 *     arkiv-best-practices), but only if the caller supplies a session key
 *     via opts; the default is project-only because Cortex episodes can
 *     legitimately be created by different session keys across time.
 */

import type { Hex } from "@arkiv-network/sdk";
import { bytesToHex } from "viem";
import { embedText } from "../compression/embeddings.ts";
import { rabitqInnerProduct, unpackCode, rabitqEncode, packCode } from "../compression/rabitq.ts";
import { ENTITY_TYPE, SEALED_CONTENT_TYPE, UTILITY } from "../constants.ts";
import { publish } from "../lib/events.ts";
import { openPayload } from "../lib/crypto.ts";
import { getPayloadKey } from "../lib/payload-key.ts";
import { recallWeightFactor } from "./utility.ts";
import { initMirrorDb, getMemoryWeights } from "../mirror/db.ts";
import { listMirroredEntities } from "../mirror/replay.ts";

export interface MemoryHit {
  entityKey: Hex;
  entityType: "observation" | "episode" | "rule";
  /** Estimated inner-product (compressed) or token-overlap (rule). Higher = better. */
  score: number;
  expiresAtBlock: number;
  /** First 200 chars if utf-8 text; hex preview if binary. */
  payloadPreview?: string;
  attributes: { key: string; value: string | number }[];
}

const PREVIEW_LIMIT = 200;
const DEFAULT_K = 5;
/** Candidate window pulled from Arkiv before in-memory scoring. */
const CANDIDATE_LIMIT = 50;
const RABITQ_PACK_SIZE = 198;

// ---------------------------------------------------------------------------
// Last-recall cache — used by act() to validate citations.
// Stored as Set<Hex> for O(1) membership check.
// ---------------------------------------------------------------------------

let _lastRecallIds: Set<Hex> = new Set();
/** Rank (0 = top) of each key in the most recent recall — feeds the SEDM proxy utility. */
let _lastRecallRanks: Map<Hex, number> = new Map();
/** k (number of hits) of the most recent recall. */
let _lastRecallK = 0;

/** Set of entity keys returned by the most recent recall. Used by act() validation. */
export function getLastRecallIds(): Set<Hex> {
  return new Set(_lastRecallIds);
}

/** Rank map (entityKey → 0-based rank) of the most recent recall. */
export function getLastRecallRanks(): Map<Hex, number> {
  return new Map(_lastRecallRanks);
}

/** k (hit count) of the most recent recall. */
export function getLastRecallK(): number {
  return _lastRecallK;
}

/** Test-only seam: clears the cache so test order doesn't leak state. */
export function _resetLastRecallIds(): void {
  _lastRecallIds = new Set();
  _lastRecallRanks = new Map();
  _lastRecallK = 0;
}

// ---------------------------------------------------------------------------
// Payload decoding + scoring
// ---------------------------------------------------------------------------

/** Cheap printable-ASCII gate. Used to decide between text vs hex preview. */
function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  const sample = bytes.subarray(0, Math.min(bytes.length, 64));
  let printable = 0;
  for (const b of sample) {
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126)) printable++;
  }
  return printable / sample.length > 0.85;
}

function previewOf(payload: Uint8Array | undefined): string | undefined {
  if (!payload || payload.length === 0) return undefined;
  if (looksLikeText(payload)) {
    try {
      const txt = new TextDecoder("utf-8", { fatal: false }).decode(payload);
      return txt.slice(0, PREVIEW_LIMIT);
    } catch {
      // fall through to hex
    }
  }
  return bytesToHex(payload.subarray(0, Math.min(payload.length, 32)));
}

/**
 * Lightweight overlap score in [0, 1]: |query_tokens ∩ rule_tokens| / |query_tokens|.
 * Cheap, deterministic, and good enough at v1 — rules are short summaries.
 */
function textOverlapScore(query: string, ruleText: string): number {
  const tokenize = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 2),
    );
  const q = tokenize(query);
  if (q.size === 0) return 0;
  const r = tokenize(ruleText);
  let hits = 0;
  for (const t of q) if (r.has(t)) hits++;
  return hits / q.size;
}

function pickEntityType(
  attrs: { key: string; value: string | number }[],
): "observation" | "episode" | "rule" | undefined {
  for (const a of attrs) {
    if (a.key !== "entityType") continue;
    if (a.value === ENTITY_TYPE.OBSERVATION) return "observation";
    if (a.value === ENTITY_TYPE.EPISODE) return "episode";
    if (a.value === ENTITY_TYPE.RULE) return "rule";
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RecallOptions {
  /** Natural-language query (will be embedded). */
  query: string;
  /** Top-k returned. Default 5. */
  k?: number;
  /** Restrict to a single tier. */
  entityType?: "observation" | "episode" | "rule";
  /** Override seam — see test files for usage. */
  _deps?: RecallDeps;
}

/**
 * Optional seam for tests — substitutes the Arkiv read and the embedding call
 * so we can validate scoring without touching Braga or OpenAI.
 */
/** A scored-candidate row as produced by the candidate fetcher. */
export interface RecallCandidate {
  key: Hex;
  payload: Uint8Array | undefined;
  attributes: { key: string; value: string | number }[];
  expiresAtBlock: bigint | undefined;
  /** Sealed payloads carry SEALED_CONTENT_TYPE; recall opens them before decoding.
   *  Absent/null ⇒ treat as plaintext (legacy + test injections). */
  contentType?: string | null;
}

export interface RecallDeps {
  /** Substitute Arkiv read. Should already filter by PROJECT_ATTRIBUTE + entityType. */
  fetchCandidates?: (entityType: string | undefined) => Promise<RecallCandidate[]>;
  /** Substitute embedding call. */
  embedQuery?: (text: string) => Promise<Float32Array>;
  /** Substitute the utility-weight lookup. Default: read the SQLite mirror. */
  loadWeights?: (keys: Hex[]) => Promise<Map<Hex, number>>;
}

/**
 * Recall up to `k` memories matching the query. Updates the lastRecallIds set
 * used by `act()` to validate citations.
 */
export async function recall(opts: RecallOptions): Promise<MemoryHit[]> {
  const k = opts.k ?? DEFAULT_K;
  if (!Number.isInteger(k) || k <= 0) {
    throw new Error(`recall: k must be a positive integer, got ${k}`);
  }
  if (typeof opts.query !== "string" || opts.query.length === 0) {
    throw new Error("recall: query must be a non-empty string");
  }

  const embed = opts._deps?.embedQuery ?? embedText;
  const fetchCandidates =
    opts._deps?.fetchCandidates ?? defaultFetchCandidates;

  // Embed once. Rule scoring doesn't need the embedding, but we do it eagerly
  // because most candidates will be observation/episode in steady state.
  const queryEmbedding = await embed(opts.query);

  // Live spine: the query is RaBitQ-encoded with the same 1-bit codec the
  // corpus uses (we keep the raw embedding for full-precision scoring, but the
  // encode is real). This keeps the RaBitQ tile live on every recall, not just
  // on memory creation. Best-effort — never let instrumentation break recall.
  try {
    const t0 = performance.now();
    const packed = packCode(rabitqEncode(queryEmbedding));
    publish({
      type: "rabitq.encoded",
      ts: Date.now(),
      dim: queryEmbedding.length,
      bytes: packed.byteLength,
      ratio: (queryEmbedding.length * 4) / packed.byteLength,
      ms: performance.now() - t0,
    });
  } catch {
    /* instrumentation only — ignore */
  }

  const candidates = await fetchCandidates(opts.entityType);

  // Wallet-derived key for opening sealed payloads. Resolved once; memoized in
  // payload-key.ts. `null` ⇒ no wallet material → sealed memories are skipped
  // (a recall miss, not a crash — the sovereignty negative control).
  const payloadKey = await getPayloadKey();

  const hits: MemoryHit[] = [];
  for (const c of candidates) {
    const t = pickEntityType(c.attributes);
    if (!t) continue;
    if (opts.entityType && t !== opts.entityType) continue;

    // Decrypt sealed payloads in RAM before decoding. The chain + mirror hold
    // ciphertext; only this step (gated by the wallet key) recovers the raw
    // RaBitQ / rule bytes. A sealed candidate we can't open is skipped.
    let raw = c.payload;
    if (raw && c.contentType === SEALED_CONTENT_TYPE) {
      if (!payloadKey) continue;
      try {
        raw = await openPayload(payloadKey, raw);
      } catch {
        continue;
      }
    }

    let score = 0;
    if (t === "rule") {
      if (raw) {
        try {
          const ruleText = new TextDecoder("utf-8", { fatal: false }).decode(raw);
          // Try JSON shape { ruleText: "..." } first, fall back to raw text.
          let body = ruleText;
          try {
            const parsed = JSON.parse(ruleText) as { ruleText?: unknown };
            if (typeof parsed?.ruleText === "string") body = parsed.ruleText;
          } catch {
            // not JSON, use raw
          }
          score = textOverlapScore(opts.query, body);
        } catch {
          score = 0;
        }
      }
    } else {
      // observation | episode — RaBitQ packed bytes.
      if (raw && raw.length === RABITQ_PACK_SIZE) {
        try {
          const code = unpackCode(raw);
          score = rabitqInnerProduct(queryEmbedding, code);
        } catch {
          score = 0;
        }
      }
    }

    hits.push({
      entityKey: c.key,
      entityType: t,
      score,
      // Only fall back to 0 for truly missing values. An explicit 0n is a
      // legitimate (already-expired) block height and must not be confused
      // with "we don't know yet"; the previous ternary collapsed both cases
      // to 0 and caused the UI to render live entities as "expired".
      expiresAtBlock:
        c.expiresAtBlock === undefined ? 0 : Number(c.expiresAtBlock),
      payloadPreview: previewOf(raw),
      attributes: c.attributes,
    });
  }

  // SEDM-fusion: fuse the evolved utility weight into the score —
  // s(q,m) = rabitqInnerProduct(q,code) · clamp(w, wMin, wMax). Defensive: any
  // failure to load weights defaults to wInit (factor 1.0), so recall never
  // breaks and behaves exactly as pre-fusion until utility data accrues.
  const loadWeights =
    opts._deps?.loadWeights ??
    (async (keys: Hex[]) => {
      try {
        return getMemoryWeights(await initMirrorDb(), keys, UTILITY.wInit);
      } catch {
        return new Map<Hex, number>();
      }
    });
  try {
    const weights = await loadWeights(hits.map((h) => h.entityKey));
    for (const h of hits) {
      h.score *= recallWeightFactor(weights.get(h.entityKey) ?? UTILITY.wInit);
    }
  } catch {
    /* weight fusion is best-effort — fall back to raw scores */
  }

  hits.sort((a, b) => b.score - a.score);
  const top = hits.slice(0, k);

  _lastRecallIds = new Set(top.map((h) => h.entityKey));
  _lastRecallRanks = new Map(top.map((h, i) => [h.entityKey, i]));
  _lastRecallK = top.length;
  return top;
}

/**
 * Default candidate fetcher — reads the LOCAL SQLite mirror, not a live Arkiv
 * query. This is the "local-first hot path": recall never round-trips the chain,
 * so it's fast, leaks no query pattern to the RPC, and (post encryption-at-rest)
 * is the only place payloads are decrypted — the mirror stores chain ciphertext.
 *
 * The mirror is kept current by the daemon (src/mirror/daemon.ts) re-syncing from
 * the public Arkiv RPC. Recall therefore requires the mirror to be synced first
 * (run the daemon / backfill); there is deliberately no chain-read fallback, since
 * sealed payloads can't be scored from chain anyway.
 *
 * Pulls live entities, optionally narrows by the `entityType` attribute (mirrors
 * the old `where(eq("entityType", …))`), and caps at CANDIDATE_LIMIT.
 */
async function defaultFetchCandidates(
  entityType: string | undefined,
): Promise<RecallCandidate[]> {
  // Over-fetch then narrow: the mirror holds non-memory entities (citation,
  // state_root, …) too, so widen the window before the entityType filter.
  const entities = await listMirroredEntities({ state: "live", limit: CANDIDATE_LIMIT * 4 });
  const out: RecallCandidate[] = [];
  for (const e of entities) {
    if (entityType && !e.attributes.some((a) => a.key === "entityType" && a.value === entityType)) {
      continue;
    }
    out.push({
      key: e.entityKey,
      payload: e.payload ?? undefined,
      attributes: e.attributes,
      expiresAtBlock: BigInt(e.expiresAtBlock),
      contentType: e.contentType,
    });
    if (out.length >= CANDIDATE_LIMIT) break;
  }
  return out;
}
