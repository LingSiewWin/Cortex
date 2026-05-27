/**
 * Cortex — Graph hero surface (judge console).
 *
 * Full-viewport MemoryGraph with HUD overlays: live memory counts, RaBitQ
 * compression, and agent budget. Memories come from wallet uploads — no
 * public "seed 20" CTA on the site.
 */

import { useMemo } from "react";
import MemoryGraph from "./MemoryGraph/MemoryGraph";
import { useSSE } from "../hooks/useSSE";
import { formatGlm } from "../format";
import type { EventOf, Hex } from "../types";

const EXPLORER = "https://explorer.braga.hoodi.arkiv.network";

interface MemoryCounts {
  total: number;
  working: number;
  episodic: number;
  rule: number;
}

interface GraphHeroProps {
  memoryCounts: MemoryCounts | null;
  compressionRatio: number | null;
  effectiveOwner: Hex | null;
  memoryCount: number | null;
}

function LiveActionStrip() {
  const cited = useSSE(["memory.cited", "anchor.committed"]);
  const latest = cited.length > 0 ? cited[cited.length - 1]!.event : null;

  if (!latest) {
    return (
      <p className="graph-action graph-action-idle mono">
        Agent cites memories every ~20s — watch nodes pulse when a lease extends.
      </p>
    );
  }

  if (latest.type === "memory.cited") {
    return (
      <p className="graph-action mono">
        <span className="graph-action-label">Cited</span>
        {latest.entityKey.slice(0, 10)}… · lease +{Math.round(latest.reinforcementSeconds / 3600)}h
        {latest.promotedTo ? ` · promoted to ${latest.promotedTo}` : ""}
      </p>
    );
  }

  if (latest.type === "anchor.committed") {
    return (
      <p className="graph-action mono">
        <span className="graph-action-label">Anchored</span>
        <a href={`${EXPLORER}/tx/${latest.txHash}`} target="_blank" rel="noreferrer">
          {latest.txHash.slice(0, 12)}…
        </a>
        <span className="muted"> · {latest.leafCount} leaves</span>
      </p>
    );
  }

  return null;
}

function EmptyGraphHint() {
  return (
    <p className="graph-action graph-action-idle mono">
      Upload a file or store a repo link below — each write adds a node to this graph.
    </p>
  );
}

export function GraphHero({
  memoryCounts,
  compressionRatio,
  effectiveOwner,
  memoryCount,
}: GraphHeroProps) {
  const rabitqEvents = useSSE(["rabitq.encoded"]);
  const spendEvents = useSSE(["allowance.spent"]);

  const latestRabitq = useMemo(() => {
    for (let i = rabitqEvents.length - 1; i >= 0; i--) {
      const ev = rabitqEvents[i]!.event;
      if (ev.type === "rabitq.encoded") return ev;
    }
    return null;
  }, [rabitqEvents]);

  const latestSpend = useMemo(() => {
    for (let i = spendEvents.length - 1; i >= 0; i--) {
      const ev = spendEvents[i]!.event;
      if (ev.type === "allowance.spent") return ev as EventOf<"allowance.spent">;
    }
    return null;
  }, [spendEvents]);

  const showEmptyHint =
    effectiveOwner !== null && memoryCount !== null && memoryCount === 0;

  return (
    <div className="graph-hero">
      <MemoryGraph surface="light" />

      <div className="graph-overlay graph-overlay-top graph-overlay--editorial" aria-hidden={false}>
        <div className="cx-tri graph-hero-stats">
          <div className="cx-tri__cell">
            <div className="cx-tri__label mono">Memories</div>
            <div className="cx-tri__value">
              {memoryCounts ? memoryCounts.total : "—"}
            </div>
            {memoryCounts ? (
              <div className="cx-tri__sub">
                {memoryCounts.working} fresh · {memoryCounts.episodic} reinforced ·{" "}
                {memoryCounts.rule} core
              </div>
            ) : null}
          </div>

          <div className="cx-tri__cell">
            <div className="cx-tri__label mono">RaBitQ</div>
            <div className="cx-tri__value mono">
              {latestRabitq
                ? `${latestRabitq.dim}d → ${latestRabitq.bytes}B`
                : compressionRatio
                  ? `${compressionRatio.toFixed(0)}×`
                  : "—"}
            </div>
            {latestRabitq ? (
              <div className="cx-tri__sub mono">
                {latestRabitq.ratio.toFixed(0)}× · {latestRabitq.ms.toFixed(1)}ms
              </div>
            ) : null}
          </div>

          <div className="cx-tri__cell">
            <div className="cx-tri__label mono">Agent budget</div>
            <div className="cx-tri__value mono">
              {latestSpend ? formatGlm(latestSpend.remainingWei) : "—"}
            </div>
            {latestSpend ? (
              <div className="cx-tri__sub mono">GLM remaining on Braga</div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="graph-overlay graph-overlay-bottom">
        {showEmptyHint ? <EmptyGraphHint /> : <LiveActionStrip />}
      </div>

      <p className="graph-legend mono">
        Nodes = memories + uploads · brightness = lease · lines = semantic k-NN + co-citation.
        Text files seal losslessly; images index by sha256 + caption.
      </p>
    </div>
  );
}
