/**
 * Cortex — MemoryGraph local wire types.
 *
 * A frontend-side mirror of `src/topology/types.ts` (the shared `/api/topology`
 * contract). Kept local — NOT imported from `src/` — so the UI bundle never
 * pulls server-only deps (`bun:sqlite`, the topology engine, etc.). Same
 * convention as `ui/types.ts`. Keep these shapes in sync with the server.
 */

export type TopologyTier = "working" | "episodic" | "rule";

/** Edge provenance (see src/topology/types.ts). bridge > cocite > nerve loudness. */
export type TopologyEdgeKind = "nerve" | "knn" | "cocite" | "bridge";

/** One Mapper node = a cluster of similar memories. */
export interface TopologyNode {
  /** Stable index within this graph snapshot (edges reference these). */
  id: number;
  /** Entity keys of the memories in this cluster. */
  memberIds: string[];
  /** Member count — drives node size. */
  size: number;
  /** Deterministic layout position (the Mapper layout IS the layout). */
  x: number;
  y: number;
  z: number;
  /** Dominant tier across members — drives hue. */
  tier: TopologyTier;
  /** Mean remaining-lease ratio in [0,1] — drives brightness (warm vs cold). */
  leaseRatio: number;
  /** Optional human label (dominant document title / memory preview). */
  label?: string;
  /** Owning project super-cluster (undefined = default bucket). */
  project?: string;
}

/** A typed topology edge: nerve | cocite | bridge. */
export interface TopologyEdge {
  a: number;
  b: number;
  /** Strength signal — drives edge opacity/brightness (see server type). */
  weight: number;
  /** Edge provenance — bridge renders loudest, then cocite, then nerve. */
  kind: TopologyEdgeKind;
}

/** A super-cluster: all node ids that belong to one project. */
export interface TopologyProject {
  name: string;
  nodeIds: number[];
}

export interface TopologyGraph {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  /** Per-project super-cluster index. */
  projects: TopologyProject[];
  /** millis since epoch when computed. */
  computedAtMs: number;
  /** Total memories that fed this graph (pre-clustering). */
  memoryCount: number;
}

/** Empty graph sentinel — render path degrades gracefully against this. */
export const EMPTY_GRAPH: TopologyGraph = {
  nodes: [],
  edges: [],
  projects: [],
  computedAtMs: 0,
  memoryCount: 0,
};
