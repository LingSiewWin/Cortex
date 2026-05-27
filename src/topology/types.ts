/**
 * Cortex — topology (Mapper graph) shared contract.
 *
 * The single shape that the server-side topology engine produces and the
 * `/api/topology` endpoint + the `<MemoryGraph>` r3f viz both consume. Keep this
 * stable — both sides bind to it.
 *
 * Design: see docs/TDA/decision-recall-and-mapper.md (lens=density, cover,
 * cluster, nerve; cosine over 1536-d vectors) and docs/TDA/touchdesigner-skill.md
 * (hue=tier, brightness=leaseRatio, size=member count).
 */

export type TopologyTier = "working" | "episodic" | "rule";

/**
 * Edge provenance — what kind of relationship an edge encodes:
 *   - "nerve"  : classic Mapper nerve edge (two clusters share members);
 *                intra-project structure.
 *   - "cocite" : the agent itself co-cited the two clusters' members in one
 *                `act` (from a CITATION entity's cite0..citeN-1 set).
 *   - "bridge" : a CROSS-project link — full-precision document cosine ≥ τ OR a
 *                shared co-citation. The "this feels intelligent" relationship
 *                ("the auth pattern you solved in repo A applies to repo B").
 */
export type TopologyEdgeKind = "nerve" | "knn" | "cocite" | "bridge";

/** One Mapper node = a cluster of similar memories. */
export interface TopologyNode {
  /** Stable index within this graph snapshot (edges reference these). */
  id: number;
  /** Entity keys of the memories in this cluster. */
  memberIds: string[];
  /** Member count — drives node size. */
  size: number;
  /** Deterministic layout position (seeded; lens drives one axis). */
  x: number;
  y: number;
  z: number;
  /** Dominant tier across members — drives hue. */
  tier: TopologyTier;
  /** Mean remaining-lease ratio in [0,1] — drives brightness (warm vs cold). */
  leaseRatio: number;
  /** Optional human label (dominant document title / memory preview). */
  label?: string;
  /**
   * Owning project (the `project` attribute shared by this node's members).
   * Memories with no project attribute fall into a shared default bucket; this
   * is undefined only for that bucket so the viz can render it neutrally.
   */
  project?: string;
}

/** A topology edge: a typed relationship between two clusters. */
export interface TopologyEdge {
  a: number;
  b: number;
  /**
   * nerve  → |members(a) ∩ members(b)| (Mapper overlap);
   * cocite → co-occurrence count (times the two clusters were co-cited);
   * bridge → a strength signal in (0,1] (cosine, or normalized co-citation).
   * Drives edge opacity/brightness.
   */
  weight: number;
  /** Edge provenance — drives the viz's visual loudness (bridge > cocite > nerve). */
  kind: TopologyEdgeKind;
}

/** A super-cluster: all node ids that belong to one project. */
export interface TopologyProject {
  /** Project name (the shared `project` attribute), or "" for the default bucket. */
  name: string;
  /** Ids of the nodes that belong to this project. */
  nodeIds: number[];
}

export interface TopologyGraph {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  /** Per-project super-cluster index (each project laid out on its own disc). */
  projects: TopologyProject[];
  /** millis since epoch when computed. */
  computedAtMs: number;
  /** Total memories that fed this graph (pre-clustering). */
  memoryCount: number;
}

/** One memory's input to the Mapper engine (already decrypted + decoded). */
export interface TopologyPoint {
  id: string;
  /** 1536-d vector: full-precision for documents, ±1 sign vector otherwise. */
  vector: Float32Array;
  tier: TopologyTier;
  /** Remaining-lease ratio in [0,1]. */
  leaseRatio: number;
  label?: string;
  /**
   * Owning project (the `project` attribute). Points without it share a single
   * default bucket — the Mapper runs per-project so cross-domain memories don't
   * smear into one blob.
   */
  project?: string;
  /**
   * True when `vector` is a recoverable full-precision embedding (Document Tier).
   * Only full-precision members may seed cross-project cosine BRIDGES — 1-bit
   * sign vectors misfire (their pairwise cosines concentrate, see
   * docs/TDA/decision-recall-and-mapper.md). Defaults to false (lossy).
   */
  fullPrecision?: boolean;
}

/**
 * A co-citation pair: two entity keys co-cited in the same `act` (parsed from a
 * CITATION entity's cite0..citeN-1 set). `count` is how many distinct acts
 * co-cited them. Lowercased keys (matching the on-chain cite* attribute form).
 */
export interface CoCitationPair {
  a: string;
  b: string;
  count: number;
}
