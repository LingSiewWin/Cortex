/**
 * Cortex — Memory Constellation (Phase 15).
 *
 * Replaces the Memory Lifespan health-bar list with a thermodynamic
 * visualization. The constellation reads as memory consolidation flowing
 * from hot (orange, fast-decaying working memories) at the top zone, to
 * promoted episodes in the middle, and frozen rules (white) at the bottom.
 *
 * Each dot is a memory:
 *   - Position is deterministic from a hash of the entityKey (so dots don't
 *     jitter between polls).
 *   - Opacity scales with `remainingRatio` so visible decay is automatic.
 *   - Color: orange (working), lighter orange (episodic), blue (rule),
 *     muted (other).
 *   - Size scales by tier — rules biggest, working smallest.
 *   - Glow: box-shadow of (size * 2) px in the dot's color.
 *
 * No physics, no animation loop — re-renders happen on the parent's poll
 * cadence and dots just slide their opacity smoothly via CSS transition.
 */

import { useEffect, useMemo, useState } from "react";
import type { MemorySummary } from "../types";
import { tierLabel, truncateAddress, formatRemaining } from "../format";
import { useSSE } from "../hooks/useSSE";

/** How long a dot keeps its "just cited" glow after a memory.cited event. */
const CITE_GLOW_MS = 2500;
/** How long the "fades, then drops" eviction animation runs before the dot is removed. */
const DROP_ANIM_MS = 1600;

interface Props {
  memories: MemorySummary[];
  onInspect?: (memory: MemorySummary) => void;
}

// FNV-1a 32-bit hash — pure, deterministic, no deps.
function hashKey(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

interface ZoneSpec {
  tier: "working" | "episodic" | "rule";
  label: string;
  // Vertical layout in % of container.
  top: number; // top edge of zone
  height: number; // height of zone
  color: string;
  glowColor: string;
  size: number; // dot diameter in px
}

const ZONES: ZoneSpec[] = [
  {
    tier: "working",
    label: "FRESH · short lease",
    top: 4,
    height: 30,
    color: "#ff5a00",
    glowColor: "rgba(255, 90, 0, 0.55)",
    size: 10,
  },
  {
    tier: "episodic",
    label: "REINFORCED · cited, growing",
    top: 36,
    height: 30,
    color: "#ff8533",
    glowColor: "rgba(255, 133, 51, 0.5)",
    size: 14,
  },
  {
    tier: "rule",
    label: "CORE · long-lived",
    top: 68,
    height: 28,
    color: "#c9cdd8",
    glowColor: "rgba(201, 205, 216, 0.6)",
    size: 22,
  },
];

interface PositionedDot {
  memory: MemorySummary;
  leftPct: number; // 0..100 within container
  topPct: number; // 0..100 within container
  size: number;
  color: string;
  glowColor: string;
  opacity: number;
  zoneLabel: string;
}

function placeDot(memory: MemorySummary, container: { x: [number, number] }): PositionedDot {
  // Map tier → zone. "other" lands in the working zone tinted muted.
  const zone =
    memory.tier === "working"
      ? ZONES[0]!
      : memory.tier === "episodic"
        ? ZONES[1]!
        : memory.tier === "rule"
          ? ZONES[2]!
          : null;

  const h = hashKey(memory.entityKey);
  const hx = (h & 0xffff) / 0xffff; // 0..1
  const hy = ((h >>> 16) & 0xffff) / 0xffff; // 0..1

  // X jitter: spread across [xLeft, xRight] of the zone-content rail.
  // The rail leaves room for the label on the left (8%) and right padding (4%).
  const [xLeft, xRight] = container.x;
  const leftPct = xLeft + hx * (xRight - xLeft);

  if (!zone) {
    // "other" → place in episodic band, muted color.
    const z = ZONES[1]!;
    const topPct = z.top + 4 + hy * (z.height - 8);
    return {
      memory,
      leftPct,
      topPct,
      size: 8,
      color: "#6b6b70",
      glowColor: "rgba(107, 107, 112, 0.35)",
      opacity: clamp(memory.remainingRatio, 0.15, 1),
      zoneLabel: "other",
    };
  }

  const topPct = zone.top + 4 + hy * (zone.height - 8);
  // Useful memories literally grow: scale the dot by its evolved SEDM weight
  // (1.0 neutral … up to ~4.0). A 61×-cited, weight-4 memory reads as a big,
  // bright star; an unproven one stays baseline. This is the Darwinian signal
  // made visible without needing a tooltip.
  const w = clamp(memory.weight, 1, 4);
  const size = Math.round(zone.size * (1 + 0.22 * (w - 1)));
  return {
    memory,
    leftPct,
    topPct,
    size,
    color: zone.color,
    glowColor: zone.glowColor,
    opacity: clamp(memory.remainingRatio, 0.15, 1),
    zoneLabel: zone.label,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

export function MemoryConstellation({ memories, onInspect }: Props) {
  const [hoverKey, setHoverKey] = useState<string | null>(null);

  // Live cite glow: when act() reinforces a memory, memory.cited fires on the
  // spine. We light that dot for CITE_GLOW_MS. A 500ms ticker re-renders so
  // glows expire smoothly. Promotion (promotedTo) slides the dot to its new
  // zone on the next parent poll — the CSS top/left transition tweens it.
  const citedEvents = useSSE(["memory.cited"]);
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);
  const recentlyCited = useMemo(() => {
    const now = Date.now();
    const m = new Set<string>();
    for (const ev of citedEvents) {
      if (ev.event.type === "memory.cited" && now - ev.event.ts < CITE_GLOW_MS) {
        m.add(ev.event.entityKey);
      }
    }
    return m;
    // force is intentionally a dep so expired glows clear on the ticker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [citedEvents, force]);

  // Live eviction: when a memory's lease elapses, memory.evicted fires. We play
  // the "fades, then drops" animation for DROP_ANIM_MS, then keep the key in
  // `gone` so the dot stays removed even if a stale poll still lists it. This is
  // the Darwinian payoff a judge watches happen in real time.
  const evictedEvents = useSSE(["memory.evicted"]);
  const { evicting, gone } = useMemo(() => {
    const now = Date.now();
    const evicting = new Set<string>();
    const gone = new Set<string>();
    for (const ev of evictedEvents) {
      if (ev.event.type !== "memory.evicted") continue;
      if (now - ev.event.ts < DROP_ANIM_MS) evicting.add(ev.event.entityKey);
      else gone.add(ev.event.entityKey);
    }
    return { evicting, gone };
    // force re-runs this on the ticker so evicting → gone transitions on time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evictedEvents, force]);

  if (memories.length === 0) {
    return (
      <div className="section">
        <div className="section-title">Memory constellation</div>
        <div className="card constellation-card">
          <div className="constellation empty">
            <div className="constellation-empty mono">
              // no memories yet — <code>bun run cite-flow</code> to seed
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Layout rail: leave 14% on the left for the zone label, 4% right padding.
  // Drop fully-evicted dots from the render (even if a stale poll still lists
  // them) so the graveyard doesn't pile up after the fall animation.
  const dots = memories
    .filter((m) => !gone.has(m.entityKey))
    .map((m) => placeDot(m, { x: [16, 96] }));

  return (
    <div className="section">
      <div className="section-title">Memory constellation</div>
      <div className="section-hint">
        Each dot is a memory living on the chain. Color is its tier (ember
        Fresh → Reinforced → frozen-white Core); a memory grows bigger the more
        your agent cites it, and fades as it nears expiry. Cite it and it
        survives; ignore it and it decays for free.
      </div>
      <div className="card constellation-card">
        <div className="constellation">
          {ZONES.map((z) => (
            <div
              key={z.tier}
              className={`constellation-zone constellation-zone-${z.tier}`}
              style={{ top: `${z.top}%`, height: `${z.height}%` }}
            >
              <div className="constellation-zone-label mono">{z.label}</div>
            </div>
          ))}
          {dots.map((d) => {
            const isHover = hoverKey === d.memory.entityKey;
            const isCited = recentlyCited.has(d.memory.entityKey);
            const isEvicting = evicting.has(d.memory.entityKey);
            const scale = isHover ? 1.4 : isCited ? 1.3 : 1;
            return (
              <div
                key={d.memory.entityKey}
                className={`constellation-dot${isCited ? " constellation-dot-cited" : ""}${isEvicting ? " constellation-dot-evicting" : ""}`}
                style={{
                  left: `${d.leftPct}%`,
                  top: `${d.topPct}%`,
                  width: d.size,
                  height: d.size,
                  background: d.color,
                  opacity: isCited ? 1 : d.opacity,
                  boxShadow: isCited
                    ? `0 0 ${d.size * 3.5}px ${d.glowColor}`
                    : `0 0 ${d.size * 2}px ${d.glowColor}`,
                  cursor: onInspect ? "pointer" : "default",
                  transform: `translate(-50%, -50%) scale(${scale})`,
                }}
                onMouseEnter={() => setHoverKey(d.memory.entityKey)}
                onMouseLeave={() =>
                  setHoverKey((cur) => (cur === d.memory.entityKey ? null : cur))
                }
                onClick={onInspect ? () => onInspect(d.memory) : undefined}
                onKeyDown={
                  onInspect
                    ? (e) => {
                        // Phase 15 a11y fix: keyboard parity with mouse —
                        // Enter/Space activates the same inspector handler the
                        // pointer onClick triggers. Without this, dots were
                        // focusable but not activatable from the keyboard.
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onInspect(d.memory);
                        }
                      }
                    : undefined
                }
                role={onInspect ? "button" : undefined}
                tabIndex={onInspect ? 0 : -1}
                aria-label={`${tierLabel(d.memory.tier)} ${truncateAddress(d.memory.entityKey)}`}
              >
                {isHover ? (
                  <div className="constellation-tooltip">
                    <div className="constellation-tooltip-key mono">
                      {truncateAddress(d.memory.entityKey)}
                    </div>
                    <div className="constellation-tooltip-meta">
                      {tierLabel(d.memory.tier)} ·{" "}
                      {formatRemaining(d.memory.remainingSeconds)} left
                    </div>
                    <div className="constellation-tooltip-meta">
                      cited {d.memory.citationCount}× · weight{" "}
                      {d.memory.weight.toFixed(1)}
                      {d.memory.promotedTo ? ` · promoted → ${d.memory.promotedTo}` : ""}
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
