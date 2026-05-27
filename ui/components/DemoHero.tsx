/**
 * Cortex — Demo hero surface.
 *
 * Full-viewport MemoryGraph with HUD overlays: live memory counts, RaBitQ
 * compression, agent budget, and a seed CTA when the wallet has no memories.
 */

import { useMemo, useState } from "react";
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

interface DemoHeroProps {
  memoryCounts: MemoryCounts | null;
  compressionRatio: number | null;
  effectiveOwner: Hex | null;
  memoryCount: number | null;
  onSeeded: () => void;
}

function SeedInline({
  effectiveOwner,
  onSeeded,
}: {
  effectiveOwner: Hex;
  onSeeded: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function seed() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/seed-memories", { method: "POST" });
      if (!res.ok) throw new Error(await res.text());
      onSeeded();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="demo-seed">
      <span>
        No memories for {effectiveOwner.slice(0, 6)}…{effectiveOwner.slice(-4)} yet.
      </span>
      <button type="button" className="demo-seed-btn" disabled={busy} onClick={seed}>
        {busy ? "Seeding…" : "Seed 20 memories"}
      </button>
      {err ? <span className="demo-seed-err">{err}</span> : null}
    </div>
  );
}

function LiveActionStrip() {
  const cited = useSSE(["memory.cited", "anchor.committed"]);
  const latest = cited.length > 0 ? cited[cited.length - 1]!.event : null;

  if (!latest) {
    return (
      <p className="demo-action demo-action-idle mono">
        Agent cites memories every ~20s — watch nodes pulse when a lease extends.
      </p>
    );
  }

  if (latest.type === "memory.cited") {
    return (
      <p className="demo-action mono">
        <span className="demo-action-label">Cited</span>
        {latest.entityKey.slice(0, 10)}… · lease +{Math.round(latest.reinforcementSeconds / 3600)}h
        {latest.promotedTo ? ` · promoted to ${latest.promotedTo}` : ""}
      </p>
    );
  }

  if (latest.type === "anchor.committed") {
    return (
      <p className="demo-action mono">
        <span className="demo-action-label">Anchored</span>
        <a href={`${EXPLORER}/tx/${latest.txHash}`} target="_blank" rel="noreferrer">
          {latest.txHash.slice(0, 12)}…
        </a>
        <span className="muted"> · {latest.leafCount} leaves</span>
      </p>
    );
  }

  return null;
}

export function DemoHero({
  memoryCounts,
  compressionRatio,
  effectiveOwner,
  memoryCount,
  onSeeded,
}: DemoHeroProps) {
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

  const showSeed =
    effectiveOwner !== null && memoryCount !== null && memoryCount === 0;

  return (
    <div className="demo-hero">
      <MemoryGraph />

      <div className="demo-overlay demo-overlay-top" aria-hidden={false}>
        <div className="demo-stat-row">
          <div className="demo-stat">
            <span className="demo-stat-label">Memories</span>
            <span className="demo-stat-value">
              {memoryCounts ? memoryCounts.total : "—"}
            </span>
            {memoryCounts ? (
              <span className="demo-stat-sub mono">
                {memoryCounts.working} fresh · {memoryCounts.episodic} reinforced ·{" "}
                {memoryCounts.rule} core
              </span>
            ) : null}
          </div>

          <div className="demo-stat">
            <span className="demo-stat-label">RaBitQ</span>
            <span className="demo-stat-value mono">
              {latestRabitq
                ? `${latestRabitq.dim}d → ${latestRabitq.bytes}B`
                : compressionRatio
                  ? `${compressionRatio.toFixed(0)}×`
                  : "—"}
            </span>
            {latestRabitq ? (
              <span className="demo-stat-sub mono">
                {latestRabitq.ratio.toFixed(0)}× · {latestRabitq.ms.toFixed(1)}ms
              </span>
            ) : null}
          </div>

          <div className="demo-stat">
            <span className="demo-stat-label">Agent budget</span>
            <span className="demo-stat-value mono">
              {latestSpend ? formatGlm(latestSpend.remainingWei) : "—"}
            </span>
            {latestSpend ? (
              <span className="demo-stat-sub mono">GLM remaining on Braga</span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="demo-overlay demo-overlay-bottom">
        {showSeed ? (
          <SeedInline effectiveOwner={effectiveOwner} onSeeded={onSeeded} />
        ) : (
          <LiveActionStrip />
        )}
      </div>

      <p className="demo-legend mono">
        Nodes = memories + uploads · brightness = lease · lines = semantic k-NN + co-citation.
        Text files seal losslessly; images index by sha256 + caption below.
      </p>
    </div>
  );
}
