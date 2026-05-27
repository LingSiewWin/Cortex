/**
 * Cortex — graphStore.
 *
 * A ref-held, mutable animation store that lives OUTSIDE React's render cycle.
 * The `useFrame` loop reads it every frame; SSE events mutate it. We NEVER call
 * setState per event or per frame — this is the bridge between the event bus
 * and the GPU buffers (per the TouchDesigner skill: "events mutate the field,
 * React does not re-render per event").
 *
 * Keyed by entityKey. The structural graph from `/api/topology` is folded in
 * via `syncFromGraph` (debounced), which (a) maps each node's members to the
 * node index and (b) seeds per-node lease/tier from the authoritative layout
 * without clobbering in-flight pulse/death animations.
 */

import type { TopologyGraph, TopologyTier } from "./types";

/** Live per-node animation state. One entry per Mapper node (by node.id). */
export interface NodeAnim {
  /** Citation flash, 0..N. Set high on cite, decays toward 0 each frame. */
  pulse: number;
  /** Smoothed lease ratio 0..1 — drives emissive brightness. */
  lease: number;
  /** Target lease (from topology); `lease` eases toward this. */
  leaseTarget: number;
  /** Birth time (seconds, store clock) — fade-in + breathe phase offset. */
  birth: number;
  /** Deterministic phase offset (radians) for organic multi-sine pulse. */
  phase: number;
  /** Spawn-in progress 0..1 (eases up after birth). */
  spawn: number;
  /** Death progress 0..1 once `dying` — drives cool→shrink→fade→despawn. */
  death: number;
  /** True once an eviction has begun for this node. */
  dying: boolean;
  /** Current tier (may be retinted on promotion). */
  tier: TopologyTier;
}

/** How long an eviction takes to play out before the node despawns (ms). */
const DEATH_MS = 600;
/** Map a memory.cited promotion target onto our tier enum. */
function promotionTier(p: "episodic" | "rule"): TopologyTier {
  return p;
}

export class GraphStore {
  /** node.id → live animation state. */
  readonly anim = new Map<number, NodeAnim>();
  /** entityKey (lowercased) → node.id, for routing events to nodes. */
  private memberToNode = new Map<string, number>();
  /** node.id → set of memberIds, to detect emptied (fully-evicted) nodes. */
  private nodeMembers = new Map<number, Set<string>>();
  /** Monotonic store clock in seconds (advanced by the render loop). */
  private clock = 0;

  /** Advance the store clock; called once per frame from useFrame. */
  tick(dt: number): void {
    this.clock += dt;
    // Decay pulses, ease lease + spawn, advance deaths.
    for (const [id, a] of this.anim) {
      if (a.pulse > 0.0001) {
        // exp-ish decay; ~1.6s half-life feels like a TD flash settling.
        a.pulse *= Math.exp(-dt * 2.2);
        if (a.pulse < 0.0001) a.pulse = 0;
      }
      if (a.spawn < 1) a.spawn = Math.min(1, a.spawn + dt * 1.6);
      // ease lease toward target
      a.lease += (a.leaseTarget - a.lease) * Math.min(1, dt * 2.5);
      if (a.dying) {
        a.death = Math.min(1, a.death + dt * (1000 / DEATH_MS));
        a.leaseTarget = 0; // cools as it dies
        if (a.death >= 1) {
          // Fully evicted → despawn (drop from the instanced field).
          this.anim.delete(id);
          this.nodeMembers.delete(id);
        }
      }
    }
  }

  now(): number {
    return this.clock;
  }

  /** Sparkle the node that owns `entityKey` (new memory or citation). */
  sparkle(entityKey: string, promotedTo?: "episodic" | "rule"): void {
    this.pulse(entityKey, promotedTo);
  }

  /** Citation flash on the node owning `entityKey`. Optional promotion retint. */
  pulse(entityKey: string, promotedTo?: "episodic" | "rule"): void {
    const id = this.memberToNode.get(entityKey.toLowerCase());
    if (id === undefined) return;
    const a = this.anim.get(id);
    if (!a || a.dying) return;
    a.pulse = 1; // sharp flash; render loop decays it
    // Citation reinforces lease — nudge target up (clamped). The authoritative
    // value arrives on the next debounced topology refetch; this is the
    // instant visual payoff in between.
    a.leaseTarget = Math.min(1, a.leaseTarget + 0.18);
    if (promotedTo) a.tier = promotionTier(promotedTo);
  }

  /** Begin the eviction animation for the node owning `entityKey`. */
  kill(entityKey: string): void {
    const id = this.memberToNode.get(entityKey.toLowerCase());
    if (id === undefined) return;
    const a = this.anim.get(id);
    if (!a) return;
    a.dying = true; // tick() ramps death 0→1 then despawns
  }

  /**
   * Fold the authoritative structural graph into the live store. Preserves
   * in-flight animation (pulse/spawn/death) for nodes that persist; seeds new
   * nodes with a fade-in; leaves dying nodes to finish their death animation
   * even if they vanished from the new graph.
   */
  syncFromGraph(graph: TopologyGraph): void {
    const seen = new Set<number>();
    const nextMemberToNode = new Map<string, number>();

    for (const node of graph.nodes) {
      seen.add(node.id);
      const members = new Set(node.memberIds.map((m) => m.toLowerCase()));
      this.nodeMembers.set(node.id, members);
      for (const m of members) nextMemberToNode.set(m, node.id);

      const existing = this.anim.get(node.id);
      if (existing) {
        // Persisting node: keep pulse/birth/death, retarget lease + tier.
        existing.leaseTarget = clamp01(node.leaseRatio);
        if (!existing.dying) existing.tier = node.tier;
      } else {
        // New node: spawn with a fade-in + bright pulse (new synapse sparkle).
        this.anim.set(node.id, {
          pulse: 1,
          lease: 0.35,
          leaseTarget: clamp01(node.leaseRatio),
          birth: this.clock,
          phase: phaseForTopologyNode(node.memberIds, node.id),
          spawn: 0,
          death: 0,
          dying: false,
          tier: node.tier,
        });
      }
    }

    // Nodes absent from the new graph: if not already dying, start dying so the
    // field cools them out gracefully rather than popping them off.
    for (const [id, a] of this.anim) {
      if (!seen.has(id) && !a.dying) a.dying = true;
    }

    this.memberToNode = nextMemberToNode;
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Stable per-node phase for shader organic pulse (0..2π). */
export function phaseForTopologyNode(memberIds: string[], nodeId: number): number {
  const key = memberIds[0] ?? String(nodeId);
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) / 4294967296) * Math.PI * 2;
}

/** Factory — one store per mounted MemoryGraph (held in a ref). */
export function createGraphStore(): GraphStore {
  return new GraphStore();
}
