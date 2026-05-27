/**
 * Cortex — build a Mapper topology graph from the live SQLite mirror.
 *
 * This is the I/O shell around the pure `buildMapper` engine. It:
 *   1. Reads live mirrored entities (the local-first store the daemon syncs from
 *      Arkiv) — same source `recall` uses, no chain round-trip.
 *   2. Decrypts sealed payloads in RAM with the wallet-derived key (skipping any
 *      it can't open — a miss, not a crash, exactly like recall's negative
 *      control for sovereignty).
 *   3. Turns each memory into a 1536-d TopologyPoint vector:
 *        - document  → the FULL-PRECISION rerank embedding sealed in its CBOR
 *                       (highest-quality clustering; title becomes the label).
 *        - obs/episode → the packed 1-bit RaBitQ code expanded to a ±1 sign
 *                       vector (length 1536), so cosine works uniformly across
 *                       tiers (sign-agreement ≈ cosine, what RaBitQ trades on).
 *   4. Computes a per-memory leaseRatio (remaining lease / nominal lifespan,
 *      clamped) from `expiresAtBlock` vs a current-block estimate — the same
 *      "max lastEventBlock = now" heuristic ui-server uses on the read path.
 *   5. Calls `buildMapper` and returns the TopologyGraph.
 *
 * Rules (entityType="rule") are distilled plain text with no embedding at v1, so
 * they cannot be placed in the cosine space and are excluded from the graph
 * (they'd be label-only noise). Documents map to tier "rule" for colour, matching
 * the shared contract's 3-tier palette.
 *
 * All external dependencies are injectable via `deps` so the engine is testable
 * without Braga / a wallet / a populated mirror.
 */

import { buildMapper, type MapperOptions } from "./mapper.ts";
import type {
  TopologyGraph,
  TopologyPoint,
  TopologyTier,
  CoCitationPair,
} from "./types.ts";
import { decodeDocumentPayload, isDocumentPayload } from "../compression/document-payload.ts";
import { unpackCode, type RaBitQCode } from "../compression/rabitq.ts";
import { SEALED_CONTENT_TYPE, ENTITY_TYPE, REINFORCEMENT, BRAGA, WORKSPACE_ATTR } from "../constants.ts";
import { openPayload } from "../lib/crypto.ts";
import { getPayloadKey } from "../lib/payload-key.ts";
import { listMirroredEntities, type MirroredEntity } from "../mirror/replay.ts";

const EMBED_DIM = 1536;
const SIGN_BYTES = EMBED_DIM >> 3; // 192
const RABITQ_PACK_SIZE = 198;
/** Window of live entities pulled from the mirror to feed the graph. */
const DEFAULT_LIMIT = 2000;

// ---------------------------------------------------------------------------
// Injectable dependencies (test seam)
// ---------------------------------------------------------------------------

export interface TopologyDeps {
  /** Substitute the mirror read. Should return live memory entities. */
  listEntities?: (limit: number) => Promise<MirroredEntity[]>;
  /** Substitute the wallet key resolution. `null` ⇒ sealed memories skipped. */
  payloadKey?: CryptoKey | null;
  /** Override the current-block estimate (else max lastEventBlock across input). */
  currentBlock?: number;
  /** Max live entities to pull. Default 2000. */
  limit?: number;
  /** Forwarded to buildMapper. */
  mapperOptions?: MapperOptions;
}

// ---------------------------------------------------------------------------
// Vector extraction
// ---------------------------------------------------------------------------

/**
 * Expand a RaBitQ packed code into a ±1 sign vector of length 1536. Bit packing
 * is MSB-first per byte (bit 7 of byte b ↔ dim 8b, matching rabitq.ts `signAt`):
 * a set bit → +1, a clear bit → -1. Cosine over these sign vectors is exactly
 * the sign-agreement RaBitQ trades on, so the same cosine metric works for both
 * documents (full-precision) and observations/episodes (sign vectors).
 */
export function signVectorFromCode(code: RaBitQCode): Float32Array {
  const signs = code.signs;
  const out = new Float32Array(EMBED_DIM);
  for (let i = 0; i < EMBED_DIM; i++) {
    const byteIdx = i >>> 3;
    const bitInByte = 7 - (i & 7);
    const bit = (signs[byteIdx]! >>> bitInByte) & 1;
    out[i] = bit ? 1 : -1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tier + lease mapping
// ---------------------------------------------------------------------------

function findAttr(
  attrs: { key: string; value: string | number }[],
  key: string,
): string | number | undefined {
  for (const a of attrs) if (a.key === key) return a.value;
  return undefined;
}

// ---------------------------------------------------------------------------
// Co-citation extraction (CITATION entities → co-cited entity-key pairs)
// ---------------------------------------------------------------------------

/**
 * Parse the cite0..citeN-1 attributes off a single CITATION entity into the set
 * of co-cited entity keys (lowercased — the on-chain cite* attribute form, see
 * src/darwinian/citation.ts buildCitationPayload). `citationCount` bounds the
 * scan but we tolerate gaps. Keys shorter than a hex address are ignored.
 */
export function parseCitationKeys(
  attrs: { key: string; value: string | number }[],
): string[] {
  const out: string[] = [];
  for (const a of attrs) {
    if (a.key.length > 4 && a.key.startsWith("cite") && /^cite\d+$/.test(a.key)) {
      if (typeof a.value === "string" && a.value.length >= 3) {
        out.push(a.value.toLowerCase());
      }
    }
  }
  return out;
}

/**
 * Turn a list of CITATION entities into accumulated co-citation pairs. Each
 * citation's co-cited set (cite0..citeN-1) contributes one count to every
 * unordered pair within it (the agent linked them in a single `act`). Pairs are
 * keyed by the ordered (lower) key tuple so the count is the number of distinct
 * acts that co-cited them. Single-citation acts contribute no pair.
 */
export function buildCoCitations(
  citations: { attributes: { key: string; value: string | number }[] }[],
): CoCitationPair[] {
  const acc = new Map<string, { a: string; b: string; count: number }>();
  for (const c of citations) {
    const keys = parseCitationKeys(c.attributes);
    // de-dupe within one act so a repeated key doesn't self-pair
    const uniq = [...new Set(keys)];
    for (let i = 0; i < uniq.length; i++) {
      for (let j = i + 1; j < uniq.length; j++) {
        const lo = uniq[i]! < uniq[j]! ? uniq[i]! : uniq[j]!;
        const hi = uniq[i]! < uniq[j]! ? uniq[j]! : uniq[i]!;
        const k = `${lo}|${hi}`;
        const cur = acc.get(k);
        if (cur) cur.count += 1;
        else acc.set(k, { a: lo, b: hi, count: 1 });
      }
    }
  }
  return [...acc.values()];
}

/**
 * Map an on-chain entityType attribute to a viz tier. Documents render as "rule"
 * (durable, long-lived) for colour, per the shared contract's 3-tier palette.
 * Returns null for types that don't belong in the topology graph.
 */
function tierFor(entityType: string | undefined): TopologyTier | null {
  switch (entityType) {
    case ENTITY_TYPE.OBSERVATION:
      return "working";
    case ENTITY_TYPE.EPISODE:
      return "episodic";
    case ENTITY_TYPE.RULE:
      return "rule";
    case ENTITY_TYPE.DOCUMENT:
      return "rule";
    default:
      return null;
  }
}

/** Nominal lifespan (seconds) for a viz tier — denominator of leaseRatio. */
function nominalLifespanSeconds(tier: TopologyTier): number {
  switch (tier) {
    case "working":
      return REINFORCEMENT.initialWorkingSeconds;
    case "episodic":
      return REINFORCEMENT.episodicReinforcementSeconds;
    case "rule":
      return REINFORCEMENT.semanticInitialSeconds;
  }
}

/**
 * Remaining-lease ratio in [0,1]: (blocks remaining × block time) / nominal
 * lifespan, clamped. Mirrors ui-server's `summariseMemory` so the graph's
 * warm/cold colouring agrees with the dashboard's decay bars.
 */
function leaseRatioFor(
  tier: TopologyTier,
  expiresAtBlock: number,
  currentBlock: number,
): number {
  const blocksRemaining = Math.max(0, expiresAtBlock - currentBlock);
  const remainingSeconds = blocksRemaining * BRAGA.blockTimeSeconds;
  const lifespan = nominalLifespanSeconds(tier);
  if (lifespan <= 0) return 0;
  const ratio = remainingSeconds / lifespan;
  return ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
}

// ---------------------------------------------------------------------------
// Core build
// ---------------------------------------------------------------------------

/**
 * Read the live mirror, decrypt + decode each memory into a TopologyPoint, and
 * run the Mapper engine. Sealed payloads we lack a key for (or can't open) are
 * skipped. Non-memory entities and rules-without-embeddings are excluded.
 */
export async function buildTopologyFromMirror(deps?: TopologyDeps): Promise<TopologyGraph> {
  const limit = deps?.limit ?? DEFAULT_LIMIT;
  const listEntities =
    deps?.listEntities ?? ((n: number) => listMirroredEntities({ state: "live", limit: n }));

  const entities = await listEntities(limit);

  // Resolve the wallet key once. `undefined` in deps ⇒ resolve from env (may be
  // null = no wallet material → sealed memories skipped, the sovereignty control).
  const payloadKey =
    deps?.payloadKey !== undefined ? deps.payloadKey : await getPayloadKey();

  // "Now" = max lastEventBlock across the live set, unless overridden — the same
  // RPC-free heuristic ui-server uses on the read path.
  let currentBlock = deps?.currentBlock;
  if (currentBlock === undefined) {
    currentBlock = 0;
    for (const e of entities) {
      if (e.lastEventBlock > currentBlock) currentBlock = e.lastEventBlock;
    }
  }

  // CITATION entities feed the co-citation edge layer (the agent's own links).
  const citationEntities: { attributes: { key: string; value: string | number }[] }[] = [];

  const points: TopologyPoint[] = [];
  for (const e of entities) {
    const entityType = findAttr(e.attributes, "entityType");

    // Collect citations for the co-citation pass — they are NOT topology points.
    if (entityType === ENTITY_TYPE.CITATION) {
      citationEntities.push({ attributes: e.attributes });
      continue;
    }

    const tier = tierFor(typeof entityType === "string" ? entityType : undefined);
    if (!tier) continue;

    // Decrypt sealed payloads in RAM; skip any we can't open.
    let raw = e.payload ?? undefined;
    if (raw && e.contentType === SEALED_CONTENT_TYPE) {
      if (!payloadKey) continue;
      try {
        raw = await openPayload(payloadKey, raw);
      } catch {
        continue;
      }
    }
    if (!raw || raw.length === 0) continue;

    let vector: Float32Array | undefined;
    let label: string | undefined;
    // Document-tier vectors are recoverable full-precision embeddings; only
    // these may seed cross-project cosine bridges (1-bit sign vectors misfire).
    let fullPrecision = false;

    if (entityType === ENTITY_TYPE.DOCUMENT) {
      // Document Tier — full-precision rerank embedding + title label.
      if (!isDocumentPayload(raw)) continue;
      try {
        const doc = decodeDocumentPayload(raw);
        vector = doc.rerankEmbedding;
        label = doc.title ?? (doc.text ? doc.text.slice(0, 60) : undefined);
        fullPrecision = true;
      } catch {
        continue;
      }
    } else if (entityType === ENTITY_TYPE.RULE) {
      // Rules are distilled plain text with no embedding at v1 — not placeable
      // in the cosine space, so they don't enter the topology graph.
      continue;
    } else {
      // observation | episode — packed 1-bit RaBitQ code → ±1 sign vector.
      if (raw.length !== RABITQ_PACK_SIZE) continue;
      try {
        vector = signVectorFromCode(unpackCode(raw));
      } catch {
        continue;
      }
    }

    if (!vector) continue;

    // Provenance: the `project` attribute is the super-cluster key (one GitHub
    // repo = one disc). Missing ⇒ default bucket (handled in buildMapper).
    const projectAttr = findAttr(e.attributes, WORKSPACE_ATTR);
    const project = typeof projectAttr === "string" && projectAttr.length > 0 ? projectAttr : undefined;

    points.push({
      id: e.entityKey,
      vector,
      tier,
      leaseRatio: leaseRatioFor(tier, e.expiresAtBlock, currentBlock),
      fullPrecision,
      ...(label !== undefined ? { label } : {}),
      ...(project !== undefined ? { project } : {}),
    });
  }

  const cocites = buildCoCitations(citationEntities);
  return buildMapper(points, deps?.mapperOptions, cocites);
}

// ---------------------------------------------------------------------------
// HTTP handler (NOT wired into ui-server — exported for the owning agent)
// ---------------------------------------------------------------------------

/**
 * GET /api/topology — compute the current Mapper graph and return it as JSON.
 * Deliberately NOT registered with ui-server here; the agent that owns the
 * server wires this export into its router.
 */
export async function handleTopologyRequest(_req: Request): Promise<Response> {
  const graph = await buildTopologyFromMirror();
  return new Response(JSON.stringify(graph), {
    headers: { "content-type": "application/json" },
  });
}

// Re-export so callers don't need a second import for the sign-vector helper.
export type { TopologyGraph } from "./types.ts";
