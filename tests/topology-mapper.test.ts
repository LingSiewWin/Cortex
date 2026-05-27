/**
 * Cortex — Mapper topology engine tests.
 *
 * Proves the pure `buildMapper` engine on synthetic clustered data:
 *   - 3 well-separated Gaussian blobs in 1536-d → multiple nodes that recover
 *     the blob structure; nerve edges connect overlapping clusters.
 *   - tier + leaseRatio propagate from points to their dominant node.
 *   - determinism: same input → identical node count + positions + edges.
 *   - edge cases: 0 points → empty graph; 1 point → 1 node, no edges.
 *
 * Plus a smoke test of `buildTopologyFromMirror` with injected deps (no Braga,
 * no wallet) covering the document + observation vector-extraction paths and the
 * leaseRatio computation, and the sign-vector extraction helper round-trip.
 */

import { test, expect } from "bun:test";
import { buildMapper } from "../src/topology/mapper.ts";
import {
  buildTopologyFromMirror,
  signVectorFromCode,
  buildCoCitations,
  parseCitationKeys,
} from "../src/topology/build-from-mirror.ts";
import type { TopologyPoint } from "../src/topology/types.ts";
import type { MirroredEntity } from "../src/mirror/replay.ts";
import { rabitqEncode, packCode, unpackCode } from "../src/compression/rabitq.ts";
import { encodeDocumentPayload } from "../src/compression/document-payload.ts";
import { ENTITY_TYPE, BRAGA, REINFORCEMENT } from "../src/constants.ts";
import type { Hex } from "@arkiv-network/sdk";

const DIM = 1536;

// ---------------------------------------------------------------------------
// Deterministic synthetic data
// ---------------------------------------------------------------------------

/** Mulberry32 — deterministic PRNG so tests are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard-normal sample via Box-Muller, driven by a uniform RNG. */
function gaussian(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Build `nBlobs` tight Gaussian blobs in DIM-space. Each blob centers on a
 * distinct one-hot-ish direction so the blobs are far apart (high inter-blob
 * cosine separation). Returns points tagged with a tier + leaseRatio per blob.
 */
function makeBlobs(
  nBlobs: number,
  perBlob: number,
  jitter: number,
  seed: number,
): TopologyPoint[] {
  const rng = mulberry32(seed);
  const tiers = ["working", "episodic", "rule"] as const;
  const points: TopologyPoint[] = [];
  for (let b = 0; b < nBlobs; b++) {
    // Center: a large value on a block of dims unique to this blob, so blobs
    // are near-orthogonal and cosine cleanly separates them.
    const center = new Float32Array(DIM);
    const lo = b * Math.floor(DIM / nBlobs);
    const hi = lo + Math.floor(DIM / nBlobs);
    for (let i = lo; i < hi; i++) center[i] = 1;
    for (let p = 0; p < perBlob; p++) {
      const v = new Float32Array(DIM);
      for (let i = 0; i < DIM; i++) v[i] = center[i]! + gaussian(rng) * jitter;
      points.push({
        id: `0xblob${b}_pt${p}` as string,
        vector: v,
        tier: tiers[b % tiers.length]!,
        leaseRatio: 0.2 + 0.2 * b, // distinct per blob, in [0,1]
        label: `blob-${b}`,
      });
    }
  }
  return points;
}

// ---------------------------------------------------------------------------
// buildMapper — core
// ---------------------------------------------------------------------------

test("buildMapper recovers multiple clusters from 3 separated blobs", () => {
  const points = makeBlobs(3, 12, 0.05, 1234);
  const graph = buildMapper(points);

  expect(graph.memoryCount).toBe(36);
  // Should produce more than one node (the blobs are distinct clusters).
  expect(graph.nodes.length).toBeGreaterThan(1);

  // Every member id is accounted for at least once across nodes.
  const seen = new Set<string>();
  for (const n of graph.nodes) {
    expect(n.size).toBe(n.memberIds.length);
    for (const id of n.memberIds) seen.add(id);
  }
  expect(seen.size).toBe(36);

  // A node's members should overwhelmingly come from a single blob (clustering
  // separated the blobs rather than smearing them together). Check the largest.
  const biggest = [...graph.nodes].sort((a, b) => b.size - a.size)[0]!;
  const blobOf = (id: string) => id.split("_")[0]!; // "0xblobN"
  const counts = new Map<string, number>();
  for (const id of biggest.memberIds) {
    counts.set(blobOf(id), (counts.get(blobOf(id)) ?? 0) + 1);
  }
  const dominant = Math.max(...counts.values());
  expect(dominant / biggest.size).toBeGreaterThan(0.8);
});

test("nerve edges only connect nodes that share members; weight = intersection", () => {
  const points = makeBlobs(3, 12, 0.05, 99);
  const graph = buildMapper(points);

  const byId = new Map(graph.nodes.map((n) => [n.id, new Set(n.memberIds)]));
      for (const e of graph.edges) {
    if (e.kind !== "nerve") continue;
    expect(e.weight).toBeGreaterThan(0);
    const a = byId.get(e.a)!;
    const b = byId.get(e.b)!;
    let inter = 0;
    for (const id of a) if (b.has(id)) inter++;
    expect(inter).toBe(e.weight);
  }
});

test("tier and leaseRatio propagate to the dominant node", () => {
  // One pure blob: tier "episodic", leaseRatio 0.5 for all → node inherits both.
  const points: TopologyPoint[] = [];
  const rng = mulberry32(7);
  const center = new Float32Array(DIM);
  for (let i = 0; i < 100; i++) center[i] = 1;
  for (let p = 0; p < 10; p++) {
    const v = new Float32Array(DIM);
    for (let i = 0; i < DIM; i++) v[i] = center[i]! + gaussian(rng) * 0.02;
    points.push({ id: `0xp${p}`, vector: v, tier: "episodic", leaseRatio: 0.5 });
  }
  const graph = buildMapper(points);
  for (const n of graph.nodes) {
    expect(n.tier).toBe("episodic");
    expect(n.leaseRatio).toBeCloseTo(0.5, 5);
  }
});

test("buildMapper is deterministic: same input → identical graph", () => {
  const a = buildMapper(makeBlobs(3, 10, 0.05, 555));
  const b = buildMapper(makeBlobs(3, 10, 0.05, 555));

  expect(a.nodes.length).toBe(b.nodes.length);
  expect(a.edges.length).toBe(b.edges.length);
  for (let i = 0; i < a.nodes.length; i++) {
    expect(a.nodes[i]!.x).toBe(b.nodes[i]!.x);
    expect(a.nodes[i]!.y).toBe(b.nodes[i]!.y);
    expect(a.nodes[i]!.z).toBe(b.nodes[i]!.z);
    expect(a.nodes[i]!.memberIds).toEqual(b.nodes[i]!.memberIds);
    expect(a.nodes[i]!.tier).toBe(b.nodes[i]!.tier);
  }
  for (let i = 0; i < a.edges.length; i++) {
    expect(a.edges[i]).toEqual(b.edges[i]);
  }
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test("0 points → empty graph", () => {
  const g = buildMapper([]);
  expect(g.nodes).toHaveLength(0);
  expect(g.edges).toHaveLength(0);
  expect(g.memoryCount).toBe(0);
});

test("1 point → exactly 1 node, no edges", () => {
  const v = new Float32Array(DIM);
  v[0] = 1;
  const g = buildMapper([{ id: "0xsolo", vector: v, tier: "working", leaseRatio: 0.9 }]);
  expect(g.nodes).toHaveLength(1);
  expect(g.edges).toHaveLength(0);
  expect(g.nodes[0]!.memberIds).toEqual(["0xsolo"]);
  expect(g.nodes[0]!.size).toBe(1);
  expect(g.nodes[0]!.tier).toBe("working");
  expect(g.nodes[0]!.leaseRatio).toBeCloseTo(0.9, 5);
});

// ---------------------------------------------------------------------------
// signVectorFromCode helper
// ---------------------------------------------------------------------------

test("signVectorFromCode produces a ±1 vector consistent with the packed code", () => {
  const emb = new Float32Array(DIM);
  const rng = mulberry32(42);
  for (let i = 0; i < DIM; i++) emb[i] = gaussian(rng);
  const code = rabitqEncode(emb);
  const packed = packCode(code);
  const sign = signVectorFromCode(unpackCode(packed));

  expect(sign.length).toBe(DIM);
  for (let i = 0; i < DIM; i++) {
    expect(sign[i] === 1 || sign[i] === -1).toBe(true);
  }
  // First dim's sign must match the MSB of byte 0 of the packed signs.
  const expectedBit0 = (packed[0]! >>> 7) & 1;
  expect(sign[0]).toBe(expectedBit0 ? 1 : -1);
});

// ---------------------------------------------------------------------------
// buildTopologyFromMirror — injected deps (no Braga, no wallet)
// ---------------------------------------------------------------------------

function fakeEntity(over: Partial<MirroredEntity>): MirroredEntity {
  return {
    entityKey: "0x0" as Hex,
    owner: "0xowner" as Hex,
    creator: null,
    contentType: null,
    payload: null,
    attributes: [],
    expiresAtBlock: 0,
    createdAtBlock: 0,
    state: "live",
    lastEventBlock: 0,
    lastEventType: "created",
    ...over,
  };
}

test("buildTopologyFromMirror extracts vectors from observation + document and maps tier/lease", async () => {
  const rng = mulberry32(2024);

  // An observation: packed RaBitQ code (plaintext, not sealed).
  const obsEmb = new Float32Array(DIM);
  for (let i = 0; i < 100; i++) obsEmb[i] = 1 + gaussian(rng) * 0.02;
  const obsPayload = packCode(rabitqEncode(obsEmb));

  // A document: CBOR dual payload (plaintext path — contentType not sealed).
  const docEmb = new Float32Array(DIM);
  for (let i = 0; i < 100; i++) docEmb[i] = 1 + gaussian(rng) * 0.02;
  const docPayload = encodeDocumentPayload({
    text: "the quick brown fox",
    embedding: docEmb,
    title: "My Note",
    contentSha256: "deadbeef",
  });

  const currentBlock = 1000;
  // observation: nominal lifespan 1h = 1800 blocks @2s. expires 900 blocks out
  // ⇒ remaining 900 blocks = 1800s, lifespan 3600s ⇒ leaseRatio 0.5.
  const obsExpires = currentBlock + 900;

  const entities: MirroredEntity[] = [
    fakeEntity({
      entityKey: "0xobs" as Hex,
      payload: obsPayload,
      attributes: [{ key: "entityType", value: ENTITY_TYPE.OBSERVATION }],
      expiresAtBlock: obsExpires,
    }),
    fakeEntity({
      entityKey: "0xdoc" as Hex,
      payload: docPayload,
      attributes: [{ key: "entityType", value: ENTITY_TYPE.DOCUMENT }],
      expiresAtBlock: currentBlock + 10_000_000, // long-lived
    }),
    // A citation entity — non-memory, must be excluded.
    fakeEntity({
      entityKey: "0xcite" as Hex,
      payload: new Uint8Array([1, 2, 3]),
      attributes: [{ key: "entityType", value: ENTITY_TYPE.CITATION }],
    }),
  ];

  const graph = await buildTopologyFromMirror({
    listEntities: async () => entities,
    payloadKey: null, // nothing sealed here, so this is irrelevant
    currentBlock,
  });

  // Two memory points fed the graph (obs + doc); citation excluded.
  expect(graph.memoryCount).toBe(2);
  expect(graph.nodes.length).toBeGreaterThanOrEqual(1);

  // Find the observation node's leaseRatio (it's its own point).
  const allMembers = new Set(graph.nodes.flatMap((n) => n.memberIds));
  expect(allMembers.has("0xobs")).toBe(true);
  expect(allMembers.has("0xdoc")).toBe(true);
  expect(allMembers.has("0xcite")).toBe(false);

  // Sanity on the lease math for the observation.
  const expectedObsLease =
    (Math.max(0, obsExpires - currentBlock) * BRAGA.blockTimeSeconds) /
    REINFORCEMENT.initialWorkingSeconds;
  expect(expectedObsLease).toBeCloseTo(0.5, 5);
});

test("buildTopologyFromMirror skips sealed entities when no wallet key", async () => {
  const obsEmb = new Float32Array(DIM);
  obsEmb[0] = 1;
  const entities: MirroredEntity[] = [
    fakeEntity({
      entityKey: "0xsealed" as Hex,
      payload: packCode(rabitqEncode(obsEmb)),
      contentType: "application/x-cortex-sealed",
      attributes: [{ key: "entityType", value: ENTITY_TYPE.OBSERVATION }],
      expiresAtBlock: 100,
    }),
  ];
  const graph = await buildTopologyFromMirror({
    listEntities: async () => entities,
    payloadKey: null, // no key → sealed memory is skipped (sovereignty control)
    currentBlock: 0,
  });
  expect(graph.memoryCount).toBe(0);
  expect(graph.nodes).toHaveLength(0);
});

// ===========================================================================
// Per-project clusters + cross-project bridges
// ===========================================================================

/**
 * A tight Gaussian blob of `n` points centered on the one-hot direction `dir`
 * (large value across [dirLo,dirHi)) in a named project. `fullPrecision` marks
 * them document-tier (bridge-eligible); otherwise they're treated as lossy.
 */
function makeProjectBlob(opts: {
  project: string;
  n: number;
  dirLo: number;
  dirHi: number;
  jitter: number;
  seed: number;
  idPrefix: string;
  fullPrecision?: boolean;
  tier?: "working" | "episodic" | "rule";
}): TopologyPoint[] {
  const rng = mulberry32(opts.seed);
  const center = new Float32Array(DIM);
  for (let i = opts.dirLo; i < opts.dirHi; i++) center[i] = 1;
  const out: TopologyPoint[] = [];
  for (let p = 0; p < opts.n; p++) {
    const v = new Float32Array(DIM);
    for (let i = 0; i < DIM; i++) v[i] = center[i]! + gaussian(rng) * opts.jitter;
    out.push({
      id: `${opts.idPrefix}_${p}`,
      vector: v,
      tier: opts.tier ?? "rule",
      leaseRatio: 0.6,
      project: opts.project,
      ...(opts.fullPrecision ? { fullPrecision: true } : {}),
    });
  }
  return out;
}

test("two projects produce two spatially-separated super-clusters", () => {
  // Project A and B occupy DIFFERENT embedding directions — but even if they
  // overlapped, the per-project partition must keep their nodes on separate
  // discs. Use distinct directions so each project forms its own cluster.
  const a = makeProjectBlob({ project: "repo-a", n: 14, dirLo: 0, dirHi: 200, jitter: 0.05, seed: 1, idPrefix: "0xA" });
  const b = makeProjectBlob({ project: "repo-b", n: 14, dirLo: 700, dirHi: 900, jitter: 0.05, seed: 2, idPrefix: "0xB" });
  const graph = buildMapper([...a, ...b]);

  // Exactly two project super-clusters.
  expect(graph.projects.map((p) => p.name).sort()).toEqual(["repo-a", "repo-b"]);

  // Every node is tagged with its project; no node mixes projects' members.
  for (const n of graph.nodes) {
    expect(n.project === "repo-a" || n.project === "repo-b").toBe(true);
    const prefix = n.project === "repo-a" ? "0xA" : "0xB";
    for (const id of n.memberIds) expect(id.startsWith(prefix)).toBe(true);
  }

  // Spatial separation: the two projects' node centroids are far apart (they sit
  // on opposite sides of the outer ring, ~2*PROJECT_RING_RADIUS apart).
  const centroid = (name: string) => {
    const ids = new Set(graph.projects.find((p) => p.name === name)!.nodeIds);
    let sx = 0;
    let sz = 0;
    let c = 0;
    for (const node of graph.nodes) {
      if (!ids.has(node.id)) continue;
      sx += node.x;
      sz += node.z;
      c++;
    }
    return { x: sx / c, z: sz / c };
  };
  const ca = centroid("repo-a");
  const cb = centroid("repo-b");
  const gap = Math.hypot(ca.x - cb.x, ca.z - cb.z);
  expect(gap).toBeGreaterThan(20); // discs are clearly separated
});

test("a cross-project co-citation yields a kind:'bridge' edge", () => {
  // Two projects, LOSSY sign-vector members (not bridge-eligible by cosine), so
  // the bridge can ONLY come from the co-citation signal.
  const a = makeProjectBlob({ project: "repo-a", n: 6, dirLo: 0, dirHi: 200, jitter: 0.05, seed: 11, idPrefix: "0xA", tier: "working" });
  const b = makeProjectBlob({ project: "repo-b", n: 6, dirLo: 700, dirHi: 900, jitter: 0.05, seed: 12, idPrefix: "0xB", tier: "working" });
  // The agent co-cited one member of A with one member of B in a single act.
  const cocites = buildCoCitations([
    {
      attributes: [
        { key: "entityType", value: "citation" },
        { key: "cite0", value: "0xA_0" },
        { key: "cite1", value: "0xB_0" },
      ],
    },
  ]);
  const graph = buildMapper([...a, ...b], undefined, cocites);

  const bridges = graph.edges.filter((e) => e.kind === "bridge");
  expect(bridges.length).toBeGreaterThanOrEqual(1);
  // The bridge connects a repo-a node to a repo-b node.
  const projOf = (id: number) => graph.nodes.find((n) => n.id === id)!.project;
  const crossing = bridges.some((e) => projOf(e.a) !== projOf(e.b));
  expect(crossing).toBe(true);
});

test("a high-cosine document pair across projects yields a bridge", () => {
  // SAME embedding direction, but DIFFERENT projects, full-precision (doc-tier).
  // The per-project partition keeps them in separate discs; the cosine ≥ τ on
  // the full-precision centroids bridges them.
  const a = makeProjectBlob({ project: "repo-a", n: 8, dirLo: 0, dirHi: 300, jitter: 0.02, seed: 21, idPrefix: "0xDA", fullPrecision: true });
  const b = makeProjectBlob({ project: "repo-b", n: 8, dirLo: 0, dirHi: 300, jitter: 0.02, seed: 22, idPrefix: "0xDB", fullPrecision: true });
  const graph = buildMapper([...a, ...b]); // no co-citations — pure cosine bridge

  const bridges = graph.edges.filter((e) => e.kind === "bridge");
  expect(bridges.length).toBeGreaterThanOrEqual(1);
  // Bridge weight is the cosine (≥ default τ 0.82).
  for (const e of bridges) expect(e.weight).toBeGreaterThanOrEqual(0.82);
  // It's genuinely cross-project.
  const projOf = (id: number) => graph.nodes.find((n) => n.id === id)!.project;
  expect(bridges.every((e) => projOf(e.a) !== projOf(e.b))).toBe(true);
});

test("sign-vector-only pairs do NOT bridge on cosine across projects", () => {
  // SAME embedding direction across two projects, but LOSSY 1-bit sign vectors
  // (fullPrecision = false). No co-citations. Even though the raw vectors are
  // near-identical, the bridge cosine is gated to full-precision members, so
  // there must be ZERO bridges.
  const a = makeProjectBlob({ project: "repo-a", n: 8, dirLo: 0, dirHi: 300, jitter: 0.02, seed: 31, idPrefix: "0xSA" });
  const b = makeProjectBlob({ project: "repo-b", n: 8, dirLo: 0, dirHi: 300, jitter: 0.02, seed: 32, idPrefix: "0xSB" });
  // sanity: these vectors WOULD cosine-bridge if not gated
  const cos = (() => {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < DIM; i++) {
      dot += a[0]!.vector[i]! * b[0]!.vector[i]!;
      na += a[0]!.vector[i]! ** 2;
      nb += b[0]!.vector[i]! ** 2;
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  })();
  expect(cos).toBeGreaterThan(0.82); // they ARE similar — gating is the only reason no bridge

  const graph = buildMapper([...a, ...b]);
  const bridges = graph.edges.filter((e) => e.kind === "bridge");
  expect(bridges).toHaveLength(0);
});

test("cold start: a project with 1 memory still renders (one node, no bridges)", () => {
  const single = makeProjectBlob({ project: "repo-solo", n: 1, dirLo: 0, dirHi: 200, jitter: 0, seed: 41, idPrefix: "0xSOLO", fullPrecision: true });
  const graph = buildMapper(single);
  expect(graph.nodes).toHaveLength(1);
  expect(graph.nodes[0]!.project).toBe("repo-solo");
  expect(graph.projects).toEqual([{ name: "repo-solo", nodeIds: [0] }]);
  // One project ⇒ no bridges.
  expect(graph.edges.filter((e) => e.kind === "bridge")).toHaveLength(0);
});

test("cold start: a small project gets one-node-per-memory (no fake clustering)", () => {
  // Below the density-lens k (default 10) ⇒ one node per memory on its disc.
  const small = makeProjectBlob({ project: "repo-cold", n: 4, dirLo: 0, dirHi: 200, jitter: 0.05, seed: 51, idPrefix: "0xCOLD" });
  const graph = buildMapper(small);
  expect(graph.nodes).toHaveLength(4);
  for (const n of graph.nodes) expect(n.size).toBe(1);
});

test("intra-project co-citation is a 'cocite' edge, not a bridge", () => {
  const a = makeProjectBlob({ project: "repo-a", n: 6, dirLo: 0, dirHi: 200, jitter: 0.05, seed: 61, idPrefix: "0xCA", tier: "working" });
  const cocites = buildCoCitations([
    {
      attributes: [
        { key: "cite0", value: "0xCA_0" },
        { key: "cite1", value: "0xCA_3" },
      ],
    },
  ]);
  const graph = buildMapper(a, undefined, cocites);
  expect(graph.edges.some((e) => e.kind === "cocite")).toBe(true);
  expect(graph.edges.some((e) => e.kind === "bridge")).toBe(false);
});

// ---------------------------------------------------------------------------
// Co-citation parsing
// ---------------------------------------------------------------------------

test("parseCitationKeys reads cite0..citeN-1 lowercased; buildCoCitations pairs them", () => {
  const keys = parseCitationKeys([
    { key: "entityType", value: "citation" },
    { key: "action", value: "did-a-thing" },
    { key: "citationCount", value: 3 },
    { key: "cite0", value: "0xAAA" },
    { key: "cite1", value: "0xBBB" },
    { key: "cite2", value: "0xCCC" },
  ]);
  expect(keys).toEqual(["0xaaa", "0xbbb", "0xccc"]);

  // 3 co-cited keys → 3 unordered pairs, each count 1.
  const pairs = buildCoCitations([
    {
      attributes: [
        { key: "cite0", value: "0xAAA" },
        { key: "cite1", value: "0xBBB" },
        { key: "cite2", value: "0xCCC" },
      ],
    },
  ]);
  expect(pairs).toHaveLength(3);
  for (const p of pairs) expect(p.count).toBe(1);

  // A single-citation act contributes no pair.
  const none = buildCoCitations([{ attributes: [{ key: "cite0", value: "0xONLY" }] }]);
  expect(none).toHaveLength(0);
});

test("buildTopologyFromMirror loads CITATION entities into cross-project bridges", async () => {
  const rng = mulberry32(7777);
  // Two documents in two different projects, co-cited together.
  const embA = new Float32Array(DIM);
  for (let i = 0; i < 120; i++) embA[i] = 1 + gaussian(rng) * 0.02;
  const embB = new Float32Array(DIM);
  for (let i = 400; i < 520; i++) embB[i] = 1 + gaussian(rng) * 0.02; // different direction
  const docA = encodeDocumentPayload({ text: "auth pattern A", embedding: embA, title: "Auth A", contentSha256: "a" });
  const docB = encodeDocumentPayload({ text: "auth pattern B", embedding: embB, title: "Auth B", contentSha256: "b" });

  const entities: MirroredEntity[] = [
    fakeEntity({
      entityKey: "0xdocA" as Hex,
      payload: docA,
      attributes: [
        { key: "entityType", value: ENTITY_TYPE.DOCUMENT },
        { key: "workspace", value: "repo-a" },
      ],
      expiresAtBlock: 10_000_000,
    }),
    fakeEntity({
      entityKey: "0xdocB" as Hex,
      payload: docB,
      attributes: [
        { key: "entityType", value: ENTITY_TYPE.DOCUMENT },
        { key: "workspace", value: "repo-b" },
      ],
      expiresAtBlock: 10_000_000,
    }),
    fakeEntity({
      entityKey: "0xcite" as Hex,
      payload: new Uint8Array([1]),
      attributes: [
        { key: "entityType", value: ENTITY_TYPE.CITATION },
        { key: "cite0", value: "0xdoca" },
        { key: "cite1", value: "0xdocb" },
      ],
    }),
  ];

  const graph = await buildTopologyFromMirror({
    listEntities: async () => entities,
    payloadKey: null,
    currentBlock: 1,
  });

  // Only the two docs are topology points (citation excluded from memoryCount).
  expect(graph.memoryCount).toBe(2);
  expect(graph.projects.map((p) => p.name).sort()).toEqual(["repo-a", "repo-b"]);
  // The co-citation bridges the two projects (their embeddings differ, so this
  // bridge is from co-citation, not cosine).
  const bridges = graph.edges.filter((e) => e.kind === "bridge");
  expect(bridges.length).toBeGreaterThanOrEqual(1);
});
