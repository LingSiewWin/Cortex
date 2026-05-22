/**
 * Cortex — MMR Tree Panel (Phase 16).
 *
 * Live visualisation of the Merkle Mountain Range as it grows. The MMR's
 * shape is *deterministic* from the leaf count: N decomposes into a sum of
 * powers of two (its binary representation), and each set bit is a perfect
 * binary tree ("mountain") of that height. We compute the whole forest from
 * leafCount alone — we only have leaf hashes (from the SSE stream), so
 * internal nodes render as small unlabeled circles and leaves as larger
 * labelled circles. Hovering a leaf lights the path up to its peak.
 *
 * Reads exclusively from the shared SSE store — no fetch, no data props.
 */

import { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useSSE } from "../hooks/useSSE";
import type { EventOf } from "../types";

type MmrEvent = EventOf<"mmr.appended">;

const MAX_LEAVES = 12;
const LEAF_GAP = 30; // px between leaf centres
const LEVEL_H = 34; // px between tree levels
const MARGIN_X = 18;
const MARGIN_TOP = 16;

interface Node {
  id: string;
  x: number;
  y: number;
  height: number; // 0 = leaf
  isPeak: boolean;
  leaf?: MmrEvent;
  parent?: string;
}

/** Decompose N into perfect-tree heights, highest mountain first (MMR order). */
function mountainHeights(n: number): number[] {
  const hs: number[] = [];
  for (let h = 30; h >= 0; h--) if (n & (1 << h)) hs.push(h);
  return hs;
}

/**
 * Build the displayable forest for the last ~MAX_LEAVES leaves. We walk the
 * mountains from the right, taking whole mountains until we've covered enough
 * leaves, then position everything bottom-up. Returns nodes + edges keyed so
 * hover can trace a leaf→peak path.
 */
function buildForest(latest: MmrEvent | null, leafEvents: MmrEvent[]) {
  if (!latest) return { nodes: [], edges: [], width: 0, height: 0, peakUp: new Map<string, string>() };
  const total = latest.leafCount;
  const mountains = mountainHeights(total);

  // hash lookup by global leaf index
  const hashByIndex = new Map<number, MmrEvent>();
  for (const e of leafEvents) hashByIndex.set(e.leafIndex, e);

  // Pick mountains from the right until we have >= MAX_LEAVES leaves shown.
  let shownLeaves = 0;
  const picked: { height: number; baseLeaf: number }[] = [];
  let cursor = total; // exclusive upper leaf index
  for (let i = mountains.length - 1; i >= 0; i--) {
    const h = mountains[i]!;
    const size = 1 << h;
    picked.unshift({ height: h, baseLeaf: cursor - size });
    cursor -= size;
    shownLeaves += size;
    if (shownLeaves >= MAX_LEAVES) break;
  }

  const nodes: Node[] = [];
  const edges: { id: string; from: Node; to: Node }[] = [];
  const peakUp = new Map<string, string>(); // child id -> parent id (for path tracing)

  let leafCol = 0;
  const bottomY = MARGIN_TOP;
  // place tallest mountain's peak highest; y grows downward, so peaks sit near top.
  const maxH = Math.max(...picked.map((p) => p.height), 0);

  for (const m of picked) {
    // recursively place a perfect tree of height m.height, returns its root node
    const place = (h: number, leafStart: number): Node => {
      if (h === 0) {
        const x = MARGIN_X + leafCol * LEAF_GAP;
        const y = MARGIN_TOP + maxH * LEVEL_H;
        const leaf = hashByIndex.get(leafStart);
        const node: Node = {
          id: `n-${leafStart}-0`,
          x,
          y,
          height: 0,
          isPeak: h === m.height,
          leaf,
        };
        leafCol += 1;
        nodes.push(node);
        return node;
      }
      const half = 1 << (h - 1);
      const left = place(h - 1, leafStart);
      const right = place(h - 1, leafStart + half);
      const x = (left.x + right.x) / 2;
      const y = MARGIN_TOP + (maxH - h) * LEVEL_H;
      const node: Node = {
        id: `n-${leafStart}-${h}`,
        x,
        y,
        height: h,
        isPeak: h === m.height,
      };
      nodes.push(node);
      edges.push({ id: `e-${left.id}`, from: left, to: node });
      edges.push({ id: `e-${right.id}`, from: right, to: node });
      peakUp.set(left.id, node.id);
      peakUp.set(right.id, node.id);
      return node;
    };
    place(m.height, m.baseLeaf);
  }

  const width = MARGIN_X * 2 + Math.max(leafCol - 1, 0) * LEAF_GAP;
  const height = MARGIN_TOP * 2 + maxH * LEVEL_H + 8;
  return { nodes, edges, width, height, peakUp };
}

function trunc4(hex: string): string {
  return hex.slice(2, 6);
}
function trunc8(hex: string): string {
  return `${hex.slice(0, 10)}…`;
}

export function MMRTreePanel({ className }: { className?: string }) {
  const spine = useSSE(["mmr.appended"]);
  const leafEvents = useMemo(
    () => spine.map((s) => s.event).filter((e): e is MmrEvent => e.type === "mmr.appended"),
    [spine],
  );
  const latest = leafEvents.length > 0 ? leafEvents[leafEvents.length - 1]! : null;
  const [hovered, setHovered] = useState<string | null>(null);

  const { nodes, edges, width, height, peakUp } = useMemo(
    () => buildForest(latest, leafEvents),
    [latest, leafEvents],
  );

  // edges on the active path from hovered leaf up to its peak
  const activeEdges = useMemo(() => {
    const set = new Set<string>();
    if (!hovered) return set;
    let cur: string | undefined = hovered;
    while (cur && peakUp.has(cur)) {
      set.add(`e-${cur}`);
      cur = peakUp.get(cur);
    }
    return set;
  }, [hovered, peakUp]);

  const newestId =
    latest != null ? `n-${latest.leafIndex}-0` : null;

  return (
    <div className={`mmr-panel${className ? ` ${className}` : ""}`}>
      <div className="mmr-header">
        <span className="mmr-title">Merkle Mountain Range</span>
        {latest ? (
          <span className="mmr-stat mono">
            leaves: {latest.leafCount.toLocaleString()} · root:{" "}
            <span className="mmr-root">{trunc8(latest.newRoot)}</span>
          </span>
        ) : null}
      </div>

      {!latest ? (
        <div className="mmr-empty mono">
          // no anchored state yet — the agent commits a root on every act()
        </div>
      ) : (
        <svg
          className="mmr-svg"
          width="100%"
          viewBox={`0 0 ${Math.max(width, 60)} ${Math.max(height, 60)}`}
          role="img"
          aria-label={`Merkle Mountain Range with ${latest.leafCount} leaves`}
        >
          {edges.map((e) => {
            const active = activeEdges.has(e.id);
            return (
              <motion.line
                key={e.id}
                className={`mmr-edge${active ? " mmr-edge-active" : ""}`}
                x1={e.from.x}
                y1={e.from.y}
                x2={e.to.x}
                y2={e.to.y}
                initial={false}
                animate={{ strokeWidth: active ? 2.4 : 1 }}
                transition={{ duration: 0.18 }}
              />
            );
          })}

          <AnimatePresence>
            {nodes.map((n) => {
              const isLeaf = n.height === 0;
              const isNew = isLeaf && n.id === newestId;
              return (
                <motion.g
                  key={n.id}
                  initial={isNew ? { opacity: 0, y: -8 } : false}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.28, ease: "easeOut" }}
                  onMouseEnter={isLeaf ? () => setHovered(n.id) : undefined}
                  onMouseLeave={isLeaf ? () => setHovered(null) : undefined}
                  style={{ cursor: isLeaf ? "pointer" : "default" }}
                >
                  <circle
                    className={
                      isLeaf
                        ? "mmr-leaf"
                        : n.isPeak
                          ? "mmr-node mmr-peak"
                          : "mmr-node"
                    }
                    cx={n.x}
                    cy={n.y}
                    r={isLeaf ? 8 : 4}
                  />
                  {isLeaf && n.leaf ? (
                    <text className="mmr-leaf-label mono" x={n.x} y={n.y + 3}>
                      {trunc4(n.leaf.leafHash)}
                    </text>
                  ) : null}
                </motion.g>
              );
            })}
          </AnimatePresence>
        </svg>
      )}
    </div>
  );
}
