/**
 * MemoryGraph — Cortex's live topological Mapper graph at TouchDesigner grade.
 *
 * One InstancedMesh of glowing billboard discs (nodes = clusters of similar
 * memories), one additive LineSegments field (edges = member overlap), a single
 * <Bloom mipmapBlur> pass, and an always-animating loop driven by data:
 *
 *   hue        = tier (working → episodic → rule)
 *   brightness = lease remaining (warm vs cold; HDR >1 so only nodes bloom)
 *   size       = cluster member count
 *   pulse      = a citation (memory.cited) — sharp emissive flash
 *   cool-drop  = an eviction (memory.evicted) — cool → shrink → fade → despawn
 *   breathe    = the graph is alive — slow global sine + per-node phase
 *
 * Structure comes from GET /api/topology (debounced refetch on SSE structural
 * events); between refetches the field animates from the ref-held graphStore,
 * mutated by SSE events. NEVER setState per event or per frame — typed buffers
 * are mutated in useFrame and `needsUpdate` flipped once.
 *
 * Self-contained: console.tsx mounts `<MemoryGraph />` with no props. Degrades
 * gracefully with an empty graph and when WebGL is unavailable.
 *
 * Convention matches `ui/components/MemoryHero/*` (raw THREE.ShaderMaterial,
 * useFrame buffer mutation, EffectComposer/Bloom from @react-three/postprocessing).
 */

import * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useFrame } from "@react-three/fiber";
import { PerformanceMonitor } from "@react-three/drei";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import { useSSE } from "../../hooks/useSSE";
import { useTopology } from "./useTopology";
import { createGraphStore, type GraphStore } from "./graphStore";
import { createNodeMaterial } from "./nodeMaterial";
import type { TopologyGraph, TopologyTier } from "./types";

// ---------------------------------------------------------------------------
// Visual language (TouchDesigner skill §"Visual language")
// ---------------------------------------------------------------------------
const BG = "#07070b"; // near-black so bloom isolates only the nodes
// Monochrome thermodynamic: ember (hot/live) → frozen white (cold/durable).
const TIER_COLOR: Record<TopologyTier, THREE.Color> = {
  working: new THREE.Color("#ff5a00"), // ember — hot, freshly written
  episodic: new THREE.Color("#ff8533"), // light ember — reinforced
  rule: new THREE.Color("#c9cdd8"), // frozen white — cold, durable
};
/** Hard cap on instances — the field is 1–3k nodes; budget for overdraw. */
const MAX_NODES = 4096;
/** Hard cap on straight (nerve + cocite) edge line vertices (2 per edge). */
const MAX_EDGES = 12000;
/** Bridges are rendered as arcs sampled into ARC_SEGMENTS straight segments. */
const ARC_SEGMENTS = 14;
/** Hard cap on bridge arcs. Each arc costs ARC_SEGMENTS*2 vertices. */
const MAX_BRIDGES = 256;
/** Bridge arc vertex budget (2 verts per segment per arc). */
const MAX_BRIDGE_VERTS = MAX_BRIDGES * ARC_SEGMENTS * 2;
/** Bright bridge tint — additive, the loudest thing on screen. */
const BRIDGE_COLOR = new THREE.Color("#ffffff");

// ---------------------------------------------------------------------------
// GraphField — the single InstancedMesh of nodes + the single LineSegments.
// ---------------------------------------------------------------------------

function GraphField({ graph, store }: { graph: TopologyGraph; store: GraphStore }) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const linesRef = useRef<THREE.LineSegments>(null);
  const bridgeRef = useRef<THREE.LineSegments>(null);

  // Reusable scratch — NO per-frame allocation.
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const scratchColor = useMemo(() => new THREE.Color(), []);

  // Billboard quad geometry (two tris) reused for every instance — cheapest
  // glow primitive (radial-falloff disc in the fragment shader).
  const quad = useMemo(() => new THREE.PlaneGeometry(1, 1), []);
  const material = useMemo(() => createNodeMaterial(), []);

  // Per-instance attribute buffers (allocated once at MAX_NODES, reused).
  const buffers = useMemo(() => {
    const aPulse = new THREE.InstancedBufferAttribute(new Float32Array(MAX_NODES), 1);
    const aLease = new THREE.InstancedBufferAttribute(new Float32Array(MAX_NODES), 1);
    const aBirth = new THREE.InstancedBufferAttribute(new Float32Array(MAX_NODES), 1);
    const aPhase = new THREE.InstancedBufferAttribute(new Float32Array(MAX_NODES), 1);
    const aSpawn = new THREE.InstancedBufferAttribute(new Float32Array(MAX_NODES), 1);
    aPulse.setUsage(THREE.DynamicDrawUsage);
    aLease.setUsage(THREE.DynamicDrawUsage);
    aBirth.setUsage(THREE.DynamicDrawUsage);
    aPhase.setUsage(THREE.DynamicDrawUsage);
    aSpawn.setUsage(THREE.DynamicDrawUsage);
    return { aPulse, aLease, aBirth, aPhase, aSpawn };
  }, []);

  // Wire the per-instance attributes onto the quad geometry once.
  useEffect(() => {
    quad.setAttribute("aPulse", buffers.aPulse);
    quad.setAttribute("aLease", buffers.aLease);
    quad.setAttribute("aBirth", buffers.aBirth);
    quad.setAttribute("aPhase", buffers.aPhase);
    quad.setAttribute("aSpawn", buffers.aSpawn);
  }, [quad, buffers]);

  // Dispose GPU resources on unmount.
  useEffect(() => {
    return () => {
      quad.dispose();
      material.dispose();
    };
  }, [quad, material]);

  // Edge line geometry — additive, opacity ∝ weight encoded into vertex colors.
  const edgeGeometry = useMemo(() => new THREE.BufferGeometry(), []);
  const edgePositions = useMemo(() => new Float32Array(MAX_EDGES * 3), []);
  const edgeColors = useMemo(() => new Float32Array(MAX_EDGES * 3), []);
  useEffect(() => {
    const posAttr = new THREE.BufferAttribute(edgePositions, 3);
    const colAttr = new THREE.BufferAttribute(edgeColors, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    colAttr.setUsage(THREE.DynamicDrawUsage);
    edgeGeometry.setAttribute("position", posAttr);
    edgeGeometry.setAttribute("color", colAttr);
    return () => edgeGeometry.dispose();
  }, [edgeGeometry, edgePositions, edgeColors]);

  const edgeMaterial = useMemo(
    () =>
      new THREE.LineBasicMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexColors: true,
        opacity: 0.85,
      }),
    [],
  );
  useEffect(() => () => edgeMaterial.dispose(), [edgeMaterial]);

  // Bridge arc geometry — a SECOND LineSegments, rendered brightest. Each bridge
  // is a quadratic arc that bows out of the cluster plane so cross-project links
  // visibly leap the gaps between super-cluster discs.
  const bridgeGeometry = useMemo(() => new THREE.BufferGeometry(), []);
  const bridgePositions = useMemo(() => new Float32Array(MAX_BRIDGE_VERTS * 3), []);
  const bridgeColors = useMemo(() => new Float32Array(MAX_BRIDGE_VERTS * 3), []);
  useEffect(() => {
    const posAttr = new THREE.BufferAttribute(bridgePositions, 3);
    const colAttr = new THREE.BufferAttribute(bridgeColors, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    colAttr.setUsage(THREE.DynamicDrawUsage);
    bridgeGeometry.setAttribute("position", posAttr);
    bridgeGeometry.setAttribute("color", colAttr);
    return () => bridgeGeometry.dispose();
  }, [bridgeGeometry, bridgePositions, bridgeColors]);

  const bridgeMaterial = useMemo(
    () =>
      new THREE.LineBasicMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexColors: true,
        opacity: 1,
      }),
    [],
  );
  useEffect(() => () => bridgeMaterial.dispose(), [bridgeMaterial]);

  // Sync the structural graph into the store whenever the (stable) graph ref
  // changes. This is the ONLY place topology structure enters the render loop.
  useEffect(() => {
    store.syncFromGraph(graph);
  }, [graph, store]);

  // Position lookup for edges: node.id → [x,y,z]. Rebuilt on graph change only.
  const nodeIndex = useMemo(() => {
    const m = new Map<number, { x: number; y: number; z: number; size: number; tier: TopologyTier }>();
    for (const n of graph.nodes) m.set(n.id, { x: n.x, y: n.y, z: n.z, size: n.size, tier: n.tier });
    return m;
  }, [graph]);

  // Max member count for size normalization (avoid div-by-zero).
  const maxSize = useMemo(() => {
    let mx = 1;
    for (const n of graph.nodes) if (n.size > mx) mx = n.size;
    return mx;
  }, [graph]);

  // Per-project super-cluster hulls: a flat circle (on the disc plane) centered
  // on the project's node centroid, sized to enclose its nodes. Drawn as a faint
  // ring into the SAME straight-edge buffer (no extra draw call), so each repo
  // reads as a distinct constellation. Skipped when there is only one project.
  const projectHulls = useMemo(() => {
    if (graph.projects.length < 2) return [];
    const pos = new Map<number, { x: number; y: number; z: number }>();
    for (const n of graph.nodes) pos.set(n.id, { x: n.x, y: n.y, z: n.z });
    const hulls: { cx: number; cy: number; cz: number; radius: number }[] = [];
    for (const proj of graph.projects) {
      let sx = 0;
      let sy = 0;
      let sz = 0;
      let n = 0;
      for (const id of proj.nodeIds) {
        const p = pos.get(id);
        if (!p) continue;
        sx += p.x;
        sy += p.y;
        sz += p.z;
        n++;
      }
      if (n === 0) continue;
      const cx = sx / n;
      const cy = sy / n;
      const cz = sz / n;
      let radius = 2;
      for (const id of proj.nodeIds) {
        const p = pos.get(id);
        if (!p) continue;
        const d = Math.hypot(p.x - cx, p.z - cz);
        if (d > radius) radius = d;
      }
      hulls.push({ cx, cy, cz, radius: radius + 2.5 });
    }
    return hulls;
  }, [graph]);

  // ---- The render loop. Reads the store, mutates buffers, flips needsUpdate. ----
  useFrame((_state, dtRaw) => {
    const dt = Math.min(dtRaw, 0.05); // clamp huge dt after a tab-switch
    store.tick(dt);
    const t = store.now();

    const mesh = meshRef.current;
    if (!mesh) return;
    (material.uniforms.uTime as { value: number }).value = t;

    // --- nodes ---
    let i = 0;
    // Iterate the structural nodes; only nodes still alive in the store render.
    for (const n of graph.nodes) {
      if (i >= MAX_NODES) break;
      const a = store.anim.get(n.id);
      if (!a) continue; // despawned

      // size = member count (normalized), shrinks during death.
      // Keep discs smaller than inter-node spacing (mapper uses golden spiral);
      // large scales + additive bloom merged few nodes into one glow blob.
      const baseScale = 0.38 + 1.05 * (n.size / maxSize);
      const deathScale = a.dying ? 1 - a.death : 1;
      const scale = baseScale * deathScale;

      dummy.position.set(n.x, n.y, n.z);
      dummy.scale.setScalar(scale);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      // tier hue (may be retinted on promotion via a.tier).
      const tierCol = TIER_COLOR[a.tier] ?? TIER_COLOR.working;
      mesh.setColorAt(i, tierCol);

      // per-instance shader attrs
      buffers.aPulse.setX(i, a.pulse);
      // lease cools to 0 during death (drives the dim-out alongside the shrink)
      buffers.aLease.setX(i, a.dying ? a.lease * (1 - a.death) : a.lease);
      buffers.aBirth.setX(i, a.birth);
      buffers.aPhase.setX(i, a.phase);
      buffers.aSpawn.setX(i, a.dying ? a.spawn * (1 - a.death) : a.spawn);
      i++;
    }
    mesh.count = i;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    buffers.aPulse.needsUpdate = true;
    buffers.aLease.needsUpdate = true;
    buffers.aBirth.needsUpdate = true;
    buffers.aPhase.needsUpdate = true;
    buffers.aSpawn.needsUpdate = true;

    // --- straight edges: nerve (faint) + cocite (medium). Bridges are drawn
    //     separately as bright arcs below. opacity ∝ weight; dim if dying. ---
    const lines = linesRef.current;
    if (lines) {
      let v = 0; // vertex cursor
      // Normalize nerve + cocite weights independently so a single huge nerve
      // overlap doesn't crush the cocite layer (different units).
      let maxNerve = 1;
      let maxKnn = 1;
      let maxCocite = 1;
      for (const e of graph.edges) {
        if (e.kind === "nerve" && e.weight > maxNerve) maxNerve = e.weight;
        else if (e.kind === "knn" && e.weight > maxKnn) maxKnn = e.weight;
        else if (e.kind === "cocite" && e.weight > maxCocite) maxCocite = e.weight;
      }
      const fewNodes = graph.nodes.length <= 32 ? 1.65 : 1;
      for (const e of graph.edges) {
        if (e.kind === "bridge") continue; // bridges handled in the arc pass
        if (v + 2 > MAX_EDGES) break;
        const na = nodeIndex.get(e.a);
        const nb = nodeIndex.get(e.b);
        if (!na || !nb) continue;
        const aa = store.anim.get(e.a);
        const ab = store.anim.get(e.b);
        if (!aa || !ab) continue; // both endpoints must still exist

        const leaseMix = 0.5 * (aa.lease + ab.lease);
        const deathMix = (aa.dying ? 1 - aa.death : 1) * (ab.dying ? 1 - ab.death : 1);

        // Loudness tiers: cocite (agent-linked) reads clearly above faint nerve.
        let b: number;
        if (e.kind === "cocite") {
          const w = e.weight / maxCocite;
          b = (0.18 + 0.7 * w) * (0.4 + 0.6 * leaseMix) * deathMix * fewNodes;
        } else if (e.kind === "knn") {
          const w = e.weight / maxKnn;
          b = (0.12 + 0.55 * w) * (0.45 + 0.55 * leaseMix) * deathMix * fewNodes;
        } else {
          const w = e.weight / maxNerve;
          b = (0.04 + 0.28 * w) * (0.35 + 0.65 * leaseMix) * deathMix * fewNodes;
        }
        const edgePulse = 0.88 + 0.12 * Math.sin(t * 0.85 + (na.x + nb.x) * 0.07);
        b *= edgePulse;

        const o = v * 3;
        edgePositions[o] = na.x;
        edgePositions[o + 1] = na.y;
        edgePositions[o + 2] = na.z;
        edgePositions[o + 3] = nb.x;
        edgePositions[o + 4] = nb.y;
        edgePositions[o + 5] = nb.z;

        // nerve: tint toward the endpoints' tiers. cocite: nudge brighter/warmer
        // so the agent-linked edges feel like a deliberate connection.
        scratchColor.copy(TIER_COLOR[na.tier] ?? TIER_COLOR.working);
        scratchColor.lerp(TIER_COLOR[nb.tier] ?? TIER_COLOR.working, 0.5);
        if (e.kind === "cocite") scratchColor.lerp(BRIDGE_COLOR, 0.25);
        scratchColor.multiplyScalar(b);
        edgeColors[o] = scratchColor.r;
        edgeColors[o + 1] = scratchColor.g;
        edgeColors[o + 2] = scratchColor.b;
        edgeColors[o + 3] = scratchColor.r;
        edgeColors[o + 4] = scratchColor.g;
        edgeColors[o + 5] = scratchColor.b;
        v += 2;
      }

      // Faint project-hull rings appended into the same buffer (no extra draw).
      const HULL_SEG = 40;
      const hullShimmer = 0.5 + 0.5 * Math.sin(t * 0.5);
      for (const h of projectHulls) {
        let prevX = h.cx + h.radius;
        let prevZ = h.cz;
        for (let s = 1; s <= HULL_SEG; s++) {
          if (v + 2 > MAX_EDGES) break;
          const ang = (s / HULL_SEG) * Math.PI * 2;
          const nx = h.cx + Math.cos(ang) * h.radius;
          const nz = h.cz + Math.sin(ang) * h.radius;
          const o = v * 3;
          edgePositions[o] = prevX;
          edgePositions[o + 1] = h.cy;
          edgePositions[o + 2] = prevZ;
          edgePositions[o + 3] = nx;
          edgePositions[o + 4] = h.cy;
          edgePositions[o + 5] = nz;
          // very faint cool outline so it reads as grouping, not structure
          const hb = 0.05 + 0.04 * hullShimmer;
          edgeColors[o] = hb * 0.5;
          edgeColors[o + 1] = hb * 0.7;
          edgeColors[o + 2] = hb;
          edgeColors[o + 3] = hb * 0.5;
          edgeColors[o + 4] = hb * 0.7;
          edgeColors[o + 5] = hb;
          prevX = nx;
          prevZ = nz;
          v += 2;
        }
      }

      edgeGeometry.setDrawRange(0, v);
      const posAttr = edgeGeometry.getAttribute("position") as THREE.BufferAttribute | undefined;
      const colAttr = edgeGeometry.getAttribute("color") as THREE.BufferAttribute | undefined;
      if (posAttr) posAttr.needsUpdate = true;
      if (colAttr) colAttr.needsUpdate = true;
    }

    // --- bridges: bright additive arcs that bow between super-cluster discs.
    //     Visually loudest layer; each arc pulses gently so it draws the eye. ---
    const bridges = bridgeRef.current;
    if (bridges) {
      let bv = 0; // bridge vertex cursor
      let arcCount = 0;
      const arcPulse = 0.85 + 0.15 * Math.sin(t * 1.3); // global shimmer
      for (const e of graph.edges) {
        if (e.kind !== "bridge") continue;
        if (arcCount >= MAX_BRIDGES) break;
        const na = nodeIndex.get(e.a);
        const nb = nodeIndex.get(e.b);
        if (!na || !nb) continue;
        const aa = store.anim.get(e.a);
        const ab = store.anim.get(e.b);
        if (!aa || !ab) continue;
        const deathMix = (aa.dying ? 1 - aa.death : 1) * (ab.dying ? 1 - ab.death : 1);
        if (deathMix <= 0) continue;

        // weight ∈ (0,1] (cosine or normalized co-citation). Bright base so even
        // a τ≈0.82 bridge reads loud.
        const intensity = (0.9 + 1.6 * e.weight) * arcPulse * deathMix;

        // Quadratic arc: midpoint lifted off the chord (out of the disc plane).
        const mx = (na.x + nb.x) * 0.5;
        const my = (na.y + nb.y) * 0.5;
        const mz = (na.z + nb.z) * 0.5;
        const dx = nb.x - na.x;
        const dz = nb.z - na.z;
        const span = Math.hypot(dx, dz);
        const lift = 6 + 0.35 * span; // taller arc for longer leaps
        const cx = mx;
        const cy = my + lift;
        const cz = mz;

        // Sample the Bézier into ARC_SEGMENTS straight segments.
        let px = na.x;
        let py = na.y;
        let pz = na.z;
        for (let s = 1; s <= ARC_SEGMENTS; s++) {
          if (bv + 2 > MAX_BRIDGE_VERTS) break;
          const u = s / ARC_SEGMENTS;
          const iu = 1 - u;
          // quadratic Bézier B(u) = iu²·P0 + 2·iu·u·C + u²·P1
          const qx = iu * iu * na.x + 2 * iu * u * cx + u * u * nb.x;
          const qy = iu * iu * na.y + 2 * iu * u * cy + u * u * nb.y;
          const qz = iu * iu * na.z + 2 * iu * u * cz + u * u * nb.z;

          const o = bv * 3;
          bridgePositions[o] = px;
          bridgePositions[o + 1] = py;
          bridgePositions[o + 2] = pz;
          bridgePositions[o + 3] = qx;
          bridgePositions[o + 4] = qy;
          bridgePositions[o + 5] = qz;

          // Bright white-hot core; fade slightly toward arc ends for a comet feel.
          const endFade = 0.55 + 0.45 * Math.sin(Math.PI * u);
          scratchColor.copy(BRIDGE_COLOR).multiplyScalar(intensity * endFade);
          bridgeColors[o] = scratchColor.r;
          bridgeColors[o + 1] = scratchColor.g;
          bridgeColors[o + 2] = scratchColor.b;
          bridgeColors[o + 3] = scratchColor.r;
          bridgeColors[o + 4] = scratchColor.g;
          bridgeColors[o + 5] = scratchColor.b;

          px = qx;
          py = qy;
          pz = qz;
          bv += 2;
        }
        arcCount++;
      }
      bridgeGeometry.setDrawRange(0, bv);
      const bPos = bridgeGeometry.getAttribute("position") as THREE.BufferAttribute | undefined;
      const bCol = bridgeGeometry.getAttribute("color") as THREE.BufferAttribute | undefined;
      if (bPos) bPos.needsUpdate = true;
      if (bCol) bCol.needsUpdate = true;
    }
  });

  return (
    <>
      <instancedMesh
        ref={meshRef}
        args={[quad, material, MAX_NODES]}
        frustumCulled={false}
      />
      <lineSegments ref={linesRef} frustumCulled={false}>
        <primitive object={edgeGeometry} attach="geometry" />
        <primitive object={edgeMaterial} attach="material" />
      </lineSegments>
      {/* Bridges — a second LineSegments, brightest layer (cross-project arcs). */}
      <lineSegments ref={bridgeRef} frustumCulled={false}>
        <primitive object={bridgeGeometry} attach="geometry" />
        <primitive object={bridgeMaterial} attach="material" />
      </lineSegments>
    </>
  );
}

// ---------------------------------------------------------------------------
// SSEBridge — subscribes once, routes events into the ref-held store.
// Renders nothing; mutates the store (no setState per event).
// ---------------------------------------------------------------------------

function SSEBridge({ store }: { store: GraphStore }) {
  const cited = useSSE(["memory.cited"]);
  const evicted = useSSE(["memory.evicted"]);
  const lastCited = useRef<string | null>(null);
  const lastEvicted = useRef<string | null>(null);

  useEffect(() => {
    if (cited.length === 0) return;
    const last = cited[cited.length - 1];
    if (!last || last.id === lastCited.current) return;
    lastCited.current = last.id;
    if (last.event.type === "memory.cited") {
      store.pulse(last.event.entityKey, last.event.promotedTo);
    }
  }, [cited, store]);

  useEffect(() => {
    if (evicted.length === 0) return;
    const last = evicted[evicted.length - 1];
    if (!last || last.id === lastEvicted.current) return;
    lastEvicted.current = last.id;
    if (last.event.type === "memory.evicted") {
      store.kill(last.event.entityKey);
    }
  }, [evicted, store]);

  return null;
}

// ---------------------------------------------------------------------------
// SlowOrbit — gentle constant camera drift so the field never reads as 2D.
// ---------------------------------------------------------------------------

function SlowOrbit() {
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const r = 60;
    state.camera.position.x = Math.sin(t * 0.06) * r;
    state.camera.position.z = Math.cos(t * 0.06) * r;
    state.camera.position.y = 8 + Math.sin(t * 0.04) * 6;
    state.camera.lookAt(0, 0, 0);
  });
  return null;
}

// ---------------------------------------------------------------------------
// WebGL availability probe — degrade gracefully when unsupported.
// ---------------------------------------------------------------------------

function webglAvailable(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    return !!(
      window.WebGLRenderingContext &&
      (canvas.getContext("webgl") || canvas.getContext("experimental-webgl"))
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// MemoryGraph — public, self-contained, no props.
// ---------------------------------------------------------------------------

export default function MemoryGraph() {
  const { graph, loading, error } = useTopology();
  // One store per mounted graph, held in a ref (lives outside React renders).
  const storeRef = useRef<GraphStore | null>(null);
  if (storeRef.current === null) storeRef.current = createGraphStore();
  const store = storeRef.current;

  const [hasWebGL, setHasWebGL] = useState(true);
  const [dpr, setDpr] = useState<number>(typeof window !== "undefined" ? Math.min(window.devicePixelRatio, 2) : 1);
  useEffect(() => {
    setHasWebGL(webglAvailable());
  }, []);

  const isEmpty = graph.nodes.length === 0;

  // Graceful states (no canvas): WebGL missing, or empty graph.
  if (!hasWebGL) {
    return (
      <div className="memory-graph memory-graph-fallback">
        <p className="memory-graph-msg">
          3D view unavailable — your browser does not expose WebGL.
        </p>
      </div>
    );
  }

  return (
    <div className="memory-graph">
      <Canvas
        gl={{ antialias: false, powerPreference: "high-performance" }}
        camera={{ position: [0, 8, 60], fov: 50 }}
        dpr={dpr}
        style={{ position: "absolute", inset: 0 }}
        onCreated={({ scene }) => {
          scene.background = new THREE.Color(BG);
        }}
      >
        <color attach="background" args={[BG]} />

        {/* drei PerformanceMonitor scales pixel ratio down on weak GPUs. */}
        <PerformanceMonitor
          onDecline={() => setDpr(1)}
          onIncline={() => setDpr(Math.min(typeof window !== "undefined" ? window.devicePixelRatio : 1, 2))}
        />

        <SlowOrbit />
        <SSEBridge store={store} />
        <GraphField graph={graph} store={store} />

        <EffectComposer>
          <Bloom
            mipmapBlur
            intensity={0.95}
            // Softer bloom so distinct nodes stay readable (small graphs were one
            // orange smear when intensity was 1.6).
            luminanceThreshold={0.42}
            luminanceSmoothing={0.22}
            radius={0.65}
          />
        </EffectComposer>
      </Canvas>

      {/* HTML overlays (siblings over the canvas), graceful states. */}
      {loading && isEmpty && (
        <div className="memory-graph-overlay">
          <p className="memory-graph-msg">Reading the memory field…</p>
        </div>
      )}
      {!loading && isEmpty && (
        <div className="memory-graph-overlay">
          <p className="memory-graph-msg">
            {error ? "Memory field unavailable." : "No memories yet."}
          </p>
          {error && <p className="memory-graph-sub">{error}</p>}
        </div>
      )}
    </div>
  );
}
