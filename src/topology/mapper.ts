/**
 * Cortex — Mapper topology engine (PURE, no I/O).
 *
 * Turns a set of decrypted memory vectors into a topological "Mapper" graph with
 * PER-PROJECT super-clusters and CROSS-PROJECT bridges. Points are partitioned by
 * their `project` attribute FIRST (one GitHub repo = one deterministic super-
 * cluster, per docs/May27discussion/SYNTHESIS-the-living-memory-node.md §"intel-
 * ligence"); the textbook density-lens Mapper then runs PER project (so cross-
 * domain memories never smear into one blob), and three typed edge layers are
 * laid on top:
 *
 *   - nerve  : classic Mapper overlap WITHIN a project (clusters that share
 *              members). Faint in the viz.
 *   - cocite : the agent itself co-cited two clusters' members in one `act`
 *              (from a CITATION entity's cite0..citeN-1 set). Medium.
 *   - bridge : a CROSS-project link — full-precision document cosine ≥ τ OR a
 *              shared co-citation. The "this feels intelligent" relationship
 *              ("the auth pattern you solved in repo A applies to repo B").
 *              LOUDEST in the viz. Bridge cosine is GATED to document-tier
 *              (full-precision) members — 1-bit sign vectors misfire (their
 *              pairwise cosines concentrate; see decision-recall-and-mapper.md).
 *
 * Per-project Mapper pipeline (textbook Mapper, pure-TS):
 *   1. Lens  = DENSITY (mean cosine to k nearest neighbours WITHIN the project).
 *   2. Cover = 1-D cubical cover over the density-lens range (~10 overlapping
 *      intervals widened by overlap_frac); overlap creates the shared members
 *      that become nerve edges.
 *   3. Cluster = single-linkage on cosine WITHIN each cover bin.
 *   4. Nerve = edge between two nodes (same project) iff their memberId sets
 *      intersect; weight = |intersection|.
 *   5. Layout = each project gets its OWN golden-angle disc, and disc centers
 *      are placed on an outer ring by a per-project hash → angle, so super-
 *      clusters are spatially separated and bridges visibly cross the gaps.
 *
 * Complexity stays O(nodes²) for the bridge pass (per-node centroids precomputed
 * during build) and O(n²) per-project for the cosine pass — fine at the ≤ few-
 * thousand-point operating scale. No external libs.
 */

import type {
  TopologyGraph,
  TopologyNode,
  TopologyEdge,
  TopologyPoint,
  TopologyProject,
  TopologyTier,
  CoCitationPair,
} from "./types.ts";

export interface MapperOptions {
  /** Neighbours for the density lens. Default min(10, n-1) per project. */
  k?: number;
  /** Cover intervals over the lens range. Default 10. */
  nIntervals?: number;
  /** Fractional overlap between adjacent cover intervals. Default 0.3. */
  overlapFrac?: number;
  /** Cosine-similarity threshold for single-linkage clustering. Default 0.6. */
  clusterCosine?: number;
  /**
   * Cosine threshold for a CROSS-project bridge between two node centroids.
   * Default 0.82. Only full-precision (document-tier) node centroids are
   * eligible — sign-vector centroids never bridge on cosine.
   */
  bridgeCosine?: number;
}

const DEFAULTS: Required<MapperOptions> = {
  k: 10,
  nIntervals: 10,
  overlapFrac: 0.3,
  clusterCosine: 0.6,
  bridgeCosine: 0.82,
};

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // ~2.39996 rad
/**
 * Multiplier on the golden-angle spiral radius so neighbouring nodes are
 * farther apart than each billboard disc — otherwise small corpora (seed demo
 * ≈8 memories) collapse visually into one additive glow blob in the WebGL view.
 */
const LAYOUT_RADIUS_SCALE = 4.0;
/** Radius of the outer ring the per-project disc centers sit on. */
const PROJECT_RING_RADIUS = 28;
/**
 * Up to this many memories per project → one Mapper node each (no cover
 * clustering). Keeps demo graphs dense and readable; larger corpora use the
 * full Mapper pipeline.
 */
const FINE_GRAIN_MAX = 24;
/** k-NN edges per node in fine-grain mode (visual "neural" wiring). */
const FINE_GRAIN_KNN = 4;
/** Sentinel project name for points with no `project` attribute. */
const DEFAULT_PROJECT = "";

// ---------------------------------------------------------------------------
// Vector math
// ---------------------------------------------------------------------------

/** Cosine similarity in [-1, 1]. Zero-norm vectors → 0 (no defined direction). */
function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
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

/**
 * Full O(m²) cosine-similarity matrix over the given points. Symmetric;
 * diagonal = 1. Computed once per project and reused by both the density lens
 * and the per-bin clustering so we never pay the dot products twice.
 */
function cosineMatrix(points: TopologyPoint[]): Float64Array[] {
  const n = points.length;
  const sim: Float64Array[] = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    sim[i]![i] = 1;
    for (let j = i + 1; j < n; j++) {
      const s = cosine(points[i]!.vector, points[j]!.vector);
      sim[i]![j] = s;
      sim[j]![i] = s;
    }
  }
  return sim;
}

// ---------------------------------------------------------------------------
// Lens — density (mean cosine to k nearest neighbours)
// ---------------------------------------------------------------------------

/**
 * Density per point = mean cosine similarity to its k nearest neighbours
 * (highest-similarity peers). Higher density ⇒ the point sits in a tightly
 * revisited region. Returns one scalar per point, parallel to `points`.
 */
function densityLens(sim: Float64Array[], k: number): number[] {
  const n = sim.length;
  if (n === 1) return [1];
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const others: number[] = [];
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      others.push(sim[i]![j]!);
    }
    others.sort((a, b) => b - a);
    const kk = Math.min(k, others.length);
    let acc = 0;
    for (let t = 0; t < kk; t++) acc += others[t]!;
    out[i] = kk > 0 ? acc / kk : 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cover — overlapping 1-D cubical intervals over the lens range
// ---------------------------------------------------------------------------

interface Interval {
  lo: number;
  hi: number;
}

function buildCover(lens: number[], nIntervals: number, overlapFrac: number): Interval[] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of lens) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi - lo < 1e-12) {
    return [{ lo: lo - 1, hi: hi + 1 }];
  }
  const base = (hi - lo) / nIntervals;
  const pad = (base * overlapFrac) / 2;
  const intervals: Interval[] = [];
  for (let i = 0; i < nIntervals; i++) {
    const a = lo + i * base;
    const b = a + base;
    intervals.push({ lo: a - pad, hi: b + pad });
  }
  return intervals;
}

/** Indices of points whose lens value falls inside the interval (inclusive). */
function pointsInInterval(lens: number[], iv: Interval): number[] {
  const out: number[] = [];
  for (let i = 0; i < lens.length; i++) {
    const v = lens[i]!;
    if (v >= iv.lo && v <= iv.hi) out.push(i);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cluster — single-linkage on cosine distance within a cover bin
// ---------------------------------------------------------------------------

function singleLinkage(
  members: number[],
  sim: Float64Array[],
  threshold: number,
): number[][] {
  const m = members.length;
  if (m === 0) return [];
  if (m === 1) return [[members[0]!]];

  const parent = new Array<number>(m);
  for (let i = 0; i < m; i++) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r]!;
    let c = x;
    while (parent[c] !== r) {
      const next = parent[c]!;
      parent[c] = r;
      c = next;
    }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  for (let i = 0; i < m; i++) {
    for (let j = i + 1; j < m; j++) {
      if (sim[members[i]!]![members[j]!]! >= threshold) union(i, j);
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < m; i++) {
    const root = find(i);
    let g = groups.get(root);
    if (!g) {
      g = [];
      groups.set(root, g);
    }
    g.push(members[i]!);
  }
  return [...groups.values()];
}

// ---------------------------------------------------------------------------
// Node aggregation
// ---------------------------------------------------------------------------

function dominantTier(members: number[], points: TopologyPoint[]): TopologyTier {
  const counts: Record<TopologyTier, number> = { working: 0, episodic: 0, rule: 0 };
  for (const idx of members) counts[points[idx]!.tier]++;
  const order: TopologyTier[] = ["rule", "episodic", "working"];
  let best: TopologyTier = "working";
  let bestCount = -1;
  for (const t of order) {
    if (counts[t] > bestCount) {
      bestCount = counts[t];
      best = t;
    }
  }
  return best;
}

function meanLeaseRatio(members: number[], points: TopologyPoint[]): number {
  if (members.length === 0) return 0;
  let acc = 0;
  for (const idx of members) acc += points[idx]!.leaseRatio;
  const v = acc / members.length;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function pickLabel(
  members: number[],
  points: TopologyPoint[],
  lens: number[],
): string | undefined {
  let best = members[0]!;
  let bestLens = lens[best]!;
  for (const idx of members) {
    if (lens[idx]! > bestLens) {
      bestLens = lens[idx]!;
      best = idx;
    }
  }
  return points[best]!.label;
}

/**
 * Mean of the FULL-PRECISION members' vectors, L2-normalized — the node's
 * centroid for cross-project cosine bridging. Returns null when the node has no
 * full-precision (document-tier) member: such nodes never seed a cosine bridge
 * (1-bit sign vectors misfire — see decision doc). Centroid is computed over the
 * shared embedding dim so cosine is well-defined.
 */
function fullPrecisionCentroid(
  members: number[],
  points: TopologyPoint[],
): Float32Array | null {
  let dim = 0;
  let n = 0;
  for (const idx of members) {
    if (points[idx]!.fullPrecision) {
      n++;
      if (points[idx]!.vector.length > dim) dim = points[idx]!.vector.length;
    }
  }
  if (n === 0 || dim === 0) return null;
  const acc = new Float64Array(dim);
  for (const idx of members) {
    const p = points[idx]!;
    if (!p.fullPrecision) continue;
    const v = p.vector;
    for (let i = 0; i < v.length; i++) acc[i]! += v[i]!;
  }
  // L2-normalize (cosine is scale-invariant, but normalizing keeps the bridge
  // dot product a direct cosine and avoids magnitude bias across nodes).
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += acc[i]! * acc[i]!;
  norm = Math.sqrt(norm);
  const out = new Float32Array(dim);
  if (norm === 0) return null;
  for (let i = 0; i < dim; i++) out[i] = acc[i]! / norm;
  return out;
}

// ---------------------------------------------------------------------------
// Deterministic layout
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit hash of a string (deterministic). */
function fnv1a(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Ring angle for a project. Centers are spread EVENLY by ordinal index
 * (guarantees separation even for near-identical names like "repo-a"/"repo-b",
 * whose raw hashes can land at nearly the same angle), with a per-project hash
 * adding a small deterministic jitter so the arrangement isn't a rigid grid.
 * Deterministic: same (index, count, name) → same angle across recomputes.
 */
function ringAngle(index: number, count: number, name: string): number {
  const base = (index / Math.max(1, count)) * Math.PI * 2;
  const slice = (Math.PI * 2) / Math.max(1, count);
  // jitter within ±25% of a slice so discs don't overlap.
  const jitter = ((fnv1a(name) / 4294967296) - 0.5) * 0.5 * slice;
  return base + jitter;
}

/**
 * Place a node deterministically WITHIN its project disc, then translate the
 * whole disc to the project's ring center. The density lens drives `y` (denser =
 * higher); `x`/`z` are a seeded golden-angle spiral keyed by the node's index
 * WITHIN the project, plus the disc center offset. The single-project / default
 * case (center at origin) reproduces the original single-disc layout.
 */
function layoutNode(
  indexInProject: number,
  lensValue: number,
  center: { x: number; z: number },
): { x: number; y: number; z: number } {
  const angle = indexInProject * GOLDEN_ANGLE;
  const radius = Math.sqrt(indexInProject + 0.5) * LAYOUT_RADIUS_SCALE;
  return {
    x: center.x + Math.cos(angle) * radius,
    y: lensValue,
    z: center.z + Math.sin(angle) * radius,
  };
}

// ---------------------------------------------------------------------------
// Per-project node build
// ---------------------------------------------------------------------------

/** A node plus the build-time scratch the edge layers need (centroid, etc.). */
interface BuiltNode {
  node: TopologyNode;
  /** Member point indices into the GLOBAL points array. */
  memberIdxs: number[];
  /** Lowercased member entity keys (for co-citation lookups). */
  memberKeysLower: Set<string>;
  /** Full-precision centroid for cross-project cosine bridges (or null). */
  centroid: Float32Array | null;
}

/**
 * Build the Mapper nodes for ONE project's points. `globalIdx` maps a local
 * project-point index → the global points-array index (for label/centroid). Node
 * ids start at `idOffset` and increment. Disc is centered at `center`.
 */
function buildProjectNodes(
  projectName: string,
  localPoints: TopologyPoint[],
  globalIdx: number[],
  globalPoints: TopologyPoint[],
  idOffset: number,
  center: { x: number; z: number },
  cfg: Required<MapperOptions>,
): BuiltNode[] {
  const m = localPoints.length;
  const built: BuiltNode[] = [];

  // Fine grain: small corpora → one node per memory (demo-dense field). Above
  // FINE_GRAIN_MAX we run the full Mapper cover + cluster pipeline.
  const projK = Math.min(cfg.k, Math.max(1, m - 1));
  const fineGrain = m <= FINE_GRAIN_MAX;

  const makeNode = (
    localMembers: number[],
    lensValue: number,
    nodeId: number,
    indexInProject: number,
  ): BuiltNode => {
    const gMembers = localMembers.map((li) => globalIdx[li]!);
    const pos = layoutNode(indexInProject, lensValue, center);
    const label = pickLabelLocal(localMembers, localPoints, gMembers, globalPoints);
    const node: TopologyNode = {
      id: nodeId,
      memberIds: gMembers.map((gi) => globalPoints[gi]!.id),
      size: gMembers.length,
      x: pos.x,
      y: pos.y,
      z: pos.z,
      tier: dominantTier(gMembers, globalPoints),
      leaseRatio: meanLeaseRatio(gMembers, globalPoints),
      ...(label !== undefined ? { label } : {}),
      ...(projectName !== DEFAULT_PROJECT ? { project: projectName } : {}),
    };
    return {
      node,
      memberIdxs: gMembers,
      memberKeysLower: new Set(gMembers.map((gi) => globalPoints[gi]!.id.toLowerCase())),
      centroid: fullPrecisionCentroid(gMembers, globalPoints),
    };
  };

  if (m === 1) {
    built.push(makeNode([0], 1, idOffset, 0));
    return built;
  }

  if (fineGrain) {
    // One node per memory on the project's disc — honest "no clustering yet".
    // Stagger lens-driven Y so nodes aren't coplanar at y=1 (which reads as a
    // flat smear when the camera orbits).
    for (let i = 0; i < m; i++) {
      const yLens = m <= 1 ? 1 : 0.35 + (i / (m - 1)) * 1.15;
      built.push(makeNode([i], yLens, idOffset + i, i));
    }
    return built;
  }

  // Full per-project Mapper.
  const sim = cosineMatrix(localPoints);
  const lens = densityLens(sim, projK);
  const cover = buildCover(lens, cfg.nIntervals, cfg.overlapFrac);

  let indexInProject = 0;
  let nextId = idOffset;
  for (const iv of cover) {
    const memberIdxs = pointsInInterval(lens, iv);
    if (memberIdxs.length === 0) continue;
    const clusters = singleLinkage(memberIdxs, sim, cfg.clusterCosine);
    for (const cluster of clusters) {
      let lensAcc = 0;
      for (const li of cluster) lensAcc += lens[li]!;
      const clusterLens = lensAcc / cluster.length;
      built.push(makeNode(cluster, clusterLens, nextId, indexInProject));
      nextId++;
      indexInProject++;
    }
  }
  return built;
}

/** pickLabel over local cluster members, resolving labels via global points. */
function pickLabelLocal(
  localMembers: number[],
  localPoints: TopologyPoint[],
  globalMembers: number[],
  globalPoints: TopologyPoint[],
): string | undefined {
  // Prefer a document-tier (full-precision) member's label — titles are the
  // crisp human anchor — else fall back to any label.
  for (let i = 0; i < globalMembers.length; i++) {
    const gp = globalPoints[globalMembers[i]!]!;
    if (gp.fullPrecision && gp.label) return gp.label;
  }
  for (let i = 0; i < globalMembers.length; i++) {
    const gp = globalPoints[globalMembers[i]!]!;
    if (gp.label) return gp.label;
  }
  void localMembers;
  void localPoints;
  return undefined;
}

// ---------------------------------------------------------------------------
// Edge layers
// ---------------------------------------------------------------------------

/**
 * k-nearest-neighbour edges within a project (fine-grain mode). Gives the
 * sparse demo field a visible neural web before Mapper cover overlap exists.
 */
function addKnnEdges(
  built: BuiltNode[],
  sim: Float64Array[],
  k: number,
  edges: TopologyEdge[],
): void {
  const n = built.length;
  if (n <= 1) return;
  const kk = Math.min(k, n - 1);
  const seen = new Set<string>();
  for (let i = 0; i < n; i++) {
    const ranked: { j: number; s: number }[] = [];
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      ranked.push({ j, s: sim[i]![j]! });
    }
    ranked.sort((a, b) => b.s - a.s);
    for (let t = 0; t < kk; t++) {
      const j = ranked[t]!.j;
      const lo = Math.min(i, j);
      const hi = Math.max(i, j);
      const key = `${lo}|${hi}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        a: built[lo]!.node.id,
        b: built[hi]!.node.id,
        weight: ranked[t]!.s,
        kind: "knn",
      });
    }
  }
}

/** Nerve edges WITHIN a project: clusters that share members. weight = |∩|. */
function addNerveEdges(built: BuiltNode[], edges: TopologyEdge[]): void {
  for (let a = 0; a < built.length; a++) {
    for (let b = a + 1; b < built.length; b++) {
      const setA = built[a]!.memberKeysLower;
      const setB = built[b]!.memberKeysLower;
      const [small, large] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
      let weight = 0;
      for (const id of small) if (large.has(id)) weight++;
      if (weight > 0) {
        edges.push({ a: built[a]!.node.id, b: built[b]!.node.id, weight, kind: "nerve" });
      }
    }
  }
}

/**
 * Co-citation edges: for each co-cited entity-key pair, map both keys to their
 * owning node ids and (if distinct) add/accumulate a `cocite` edge with weight =
 * total co-occurrence count. A key may belong to several nodes (cover overlap);
 * we connect every owning-node pair. Intra-project co-citations ARE allowed (the
 * agent linking two clusters in one repo is signal too); cross-project pairs are
 * separately promoted to bridges by addBridges, so we DON'T duplicate them here.
 */
export function addCoCitationEdges(
  nodes: BuiltNode[],
  cocites: CoCitationPair[],
  edges: TopologyEdge[],
): void {
  if (cocites.length === 0) return;
  // entityKey(lower) → node ids that contain it.
  const keyToNodes = new Map<string, number[]>();
  for (let i = 0; i < nodes.length; i++) {
    for (const key of nodes[i]!.memberKeysLower) {
      let arr = keyToNodes.get(key);
      if (!arr) {
        arr = [];
        keyToNodes.set(key, arr);
      }
      arr.push(i);
    }
  }
  const projectOf = (nodeIdx: number): string => nodes[nodeIdx]!.node.project ?? DEFAULT_PROJECT;
  // Accumulate weights keyed by an ordered node-id pair.
  const acc = new Map<string, { a: number; b: number; w: number }>();
  for (const pair of cocites) {
    const an = keyToNodes.get(pair.a.toLowerCase());
    const bn = keyToNodes.get(pair.b.toLowerCase());
    if (!an || !bn) continue;
    for (const ia of an) {
      for (const ib of bn) {
        if (ia === ib) continue;
        // Cross-project co-citations are handled as bridges, not cocite edges.
        if (projectOf(ia) !== projectOf(ib)) continue;
        const idA = nodes[ia]!.node.id;
        const idB = nodes[ib]!.node.id;
        const lo = Math.min(idA, idB);
        const hi = Math.max(idA, idB);
        const k = `${lo}|${hi}`;
        const cur = acc.get(k);
        if (cur) cur.w += pair.count;
        else acc.set(k, { a: lo, b: hi, w: pair.count });
      }
    }
  }
  for (const { a, b, w } of acc.values()) {
    edges.push({ a, b, weight: w, kind: "cocite" });
  }
}

/**
 * Cross-project BRIDGES — the "feels intelligent" layer. For every CROSS-project
 * node pair, add a `bridge` edge iff EITHER:
 *   (a) both nodes have a full-precision centroid AND their cosine ≥ τ_bridge
 *       (gated to document-tier members — 1-bit sign vectors never bridge), OR
 *   (b) the two nodes share a co-citation (the agent itself linked them across
 *       repos).
 * Bridge weight ∈ (0,1]: the cosine for (a), or a normalized co-citation
 * strength for (b); when both fire, the max. O(nodes²) using precomputed
 * centroids.
 */
export function addBridges(
  nodes: BuiltNode[],
  cocites: CoCitationPair[],
  edges: TopologyEdge[],
  tauBridge: number,
): void {
  const projectOf = (i: number): string => nodes[i]!.node.project ?? DEFAULT_PROJECT;

  // Pre-index cross-project co-citation strength by ordered node-id pair.
  const cociteBridge = new Map<string, number>();
  if (cocites.length > 0) {
    const keyToNodes = new Map<string, number[]>();
    for (let i = 0; i < nodes.length; i++) {
      for (const key of nodes[i]!.memberKeysLower) {
        let arr = keyToNodes.get(key);
        if (!arr) {
          arr = [];
          keyToNodes.set(key, arr);
        }
        arr.push(i);
      }
    }
    let maxCount = 1;
    for (const p of cocites) if (p.count > maxCount) maxCount = p.count;
    for (const pair of cocites) {
      const an = keyToNodes.get(pair.a.toLowerCase());
      const bn = keyToNodes.get(pair.b.toLowerCase());
      if (!an || !bn) continue;
      for (const ia of an) {
        for (const ib of bn) {
          if (ia === ib) continue;
          if (projectOf(ia) === projectOf(ib)) continue; // only cross-project
          const lo = Math.min(ia, ib);
          const hi = Math.max(ia, ib);
          const k = `${lo}|${hi}`;
          // normalized co-citation strength in (0,1]
          const strength = Math.min(1, pair.count / maxCount);
          const cur = cociteBridge.get(k) ?? 0;
          if (strength > cur) cociteBridge.set(k, strength);
        }
      }
    }
  }

  const emitted = new Set<string>();
  for (let a = 0; a < nodes.length; a++) {
    for (let b = a + 1; b < nodes.length; b++) {
      if (projectOf(a) === projectOf(b)) continue; // CROSS-project only
      const pairKey = `${a}|${b}`;

      let weight = 0;

      // (a) full-precision cosine bridge (gated — both centroids must exist).
      const ca = nodes[a]!.centroid;
      const cb = nodes[b]!.centroid;
      if (ca && cb) {
        const cos = cosine(ca, cb);
        if (cos >= tauBridge) weight = Math.max(weight, cos);
      }

      // (b) shared cross-project co-citation.
      const co = cociteBridge.get(pairKey);
      if (co !== undefined) weight = Math.max(weight, co);

      if (weight > 0 && !emitted.has(pairKey)) {
        emitted.add(pairKey);
        edges.push({ a: nodes[a]!.node.id, b: nodes[b]!.node.id, weight, kind: "bridge" });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a per-project Mapper topology graph with cross-project bridges.
 *
 * Edge cases:
 *   - 0 points → empty graph (no nodes, no edges, no projects).
 *   - 1 point → exactly 1 node, no edges, 1 project.
 *   - a single project (or all default-bucket) → one disc at the origin, no
 *     bridges (bridges need ≥2 projects).
 *
 * Determinism: identical `points` (same order, vectors, projects) + identical
 * `cocites` produce an identical graph — node count, member sets, ids, edges,
 * coordinates, and project index.
 */
export function buildMapper(
  points: TopologyPoint[],
  opts?: MapperOptions,
  cocites: CoCitationPair[] = [],
): TopologyGraph {
  const computedAtMs = Date.now();
  const memoryCount = points.length;

  if (memoryCount === 0) {
    return { nodes: [], edges: [], projects: [], computedAtMs, memoryCount: 0 };
  }

  const cfg: Required<MapperOptions> = {
    k: opts?.k ?? DEFAULTS.k,
    nIntervals: opts?.nIntervals ?? DEFAULTS.nIntervals,
    overlapFrac: opts?.overlapFrac ?? DEFAULTS.overlapFrac,
    clusterCosine: opts?.clusterCosine ?? DEFAULTS.clusterCosine,
    bridgeCosine: opts?.bridgeCosine ?? DEFAULTS.bridgeCosine,
  };

  // 1. Partition points by project (stable insertion order = first appearance).
  const projectOrder: string[] = [];
  const byProject = new Map<string, number[]>(); // project → global point indices
  for (let i = 0; i < points.length; i++) {
    const name = points[i]!.project ?? DEFAULT_PROJECT;
    let arr = byProject.get(name);
    if (!arr) {
      arr = [];
      byProject.set(name, arr);
      projectOrder.push(name);
    }
    arr.push(i);
  }

  const singleProject = projectOrder.length === 1;

  // 2. Run the per-project Mapper. Each project gets its own disc; disc centers
  //    sit on an outer ring by per-project hash → angle. A single project (or
  //    the all-default-bucket case) keeps the origin so the layout reproduces
  //    the classic single-disc field.
  const allBuilt: BuiltNode[] = [];
  let idOffset = 0;
  for (let pi = 0; pi < projectOrder.length; pi++) {
    const name = projectOrder[pi]!;
    const globalIdx = byProject.get(name)!;
    const localPoints = globalIdx.map((gi) => points[gi]!);
    const center = singleProject
      ? { x: 0, z: 0 }
      : (() => {
          const ang = ringAngle(pi, projectOrder.length, name);
          return { x: Math.cos(ang) * PROJECT_RING_RADIUS, z: Math.sin(ang) * PROJECT_RING_RADIUS };
        })();
    const built = buildProjectNodes(
      name,
      localPoints,
      globalIdx,
      points,
      idOffset,
      center,
      cfg,
    );
    for (const bn of built) allBuilt.push(bn);
    idOffset += built.length;
  }

  // 3. Edge layers.
  const edges: TopologyEdge[] = [];

  // 3a. Nerve — within each project only (group built nodes by project).
  {
    const groups = new Map<string, BuiltNode[]>();
    for (const bn of allBuilt) {
      const name = bn.node.project ?? DEFAULT_PROJECT;
      let g = groups.get(name);
      if (!g) {
        g = [];
        groups.set(name, g);
      }
      g.push(bn);
    }
    for (const [name, g] of groups) {
      const localIdx = byProject.get(name)!;
      const localPoints = localIdx.map((gi) => points[gi]!);
      const fine = localPoints.length <= FINE_GRAIN_MAX;
      if (fine && g.length >= 2) {
        const sim = cosineMatrix(localPoints);
        addKnnEdges(g, sim, FINE_GRAIN_KNN, edges);
      } else {
        addNerveEdges(g, edges);
      }
    }
  }

  // 3b. Co-citation — intra-project agent-linked clusters.
  addCoCitationEdges(allBuilt, cocites, edges);

  // 3c. Bridges — cross-project only; needs ≥2 projects.
  if (projectOrder.length >= 2) {
    addBridges(allBuilt, cocites, edges, cfg.bridgeCosine);
  }

  // 4. Project super-cluster index.
  const projects: TopologyProject[] = projectOrder.map((name) => ({
    name,
    nodeIds: allBuilt.filter((bn) => (bn.node.project ?? DEFAULT_PROJECT) === name).map((bn) => bn.node.id),
  }));

  const nodes = allBuilt.map((bn) => bn.node);
  return { nodes, edges, projects, computedAtMs, memoryCount };
}
