/**
 * Cortex — Ambient Dashboard React root.
 *
 * Phase 15: Apple-tier dark theme with thermodynamic memory metaphor
 * (orange = hot working/episodic, blue = cold rules + anchors).
 *
 * Ambient mode (default) is the narrative surface — hero anchor pulse,
 * memory constellation, decision timeline, allowance, market.
 *
 * Dev mode appends the diagnostic surfaces — trilemma scoreboard, hero
 * stat grid, RaBitQ + Proof playgrounds, recently evicted, raw memory
 * lifespan health bars.
 *
 * The agent is a background process; this page reads the SQLite mirror
 * via the JSON API in src/ui-server.ts and surfaces live state.
 */

import { StrictMode, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { WalletConnect } from "./components/WalletConnect";
import { StatCard } from "./components/StatCard";
import { MemoryHealthBar } from "./components/MemoryHealthBar";
import { ListingCard } from "./components/ListingCard";
import { RaBitQPlayground } from "./components/RaBitQPlayground";
import { AllowanceCard } from "./components/AllowanceCard";
import { ProofPlayground } from "./components/ProofPlayground";
import { MemoryConstellation } from "./components/MemoryConstellation";
import { AnchorPulse } from "./components/AnchorPulse";
import { DecisionTimeline } from "./components/DecisionTimeline";
import { DevModeToggle } from "./components/DevModeToggle";
import { formatGlm, truncateAddress } from "./format";
import type {
  DecisionsResponse,
  Hex,
  ListingsResponse,
  MemoriesResponse,
  MemoryDetailResponse,
  MemorySummary,
} from "./types";

const REFRESH_INTERVAL_MS = 4_000;
const MODE_STORAGE_KEY = "cortex_console_mode";

type ConsoleMode = "ambient" | "dev";

interface EconomicsResponse {
  entityCount: number;
  totalGasUnits: number;
  totalGasCostWei: string;
  avgGasPerMemory: number;
  rawBytesEstimate: number;
  storedBytesEstimate: number;
  compressionRatio: number;
  uncompressedGasCostWei: string;
  monthlyProjectionWei: string;
}

interface DecayResponse {
  recentlyEvicted: Array<{
    entityKey: Hex;
    blockNumber: number;
    observedAtMs: number;
    gasReclaimedEstimate: number;
  }>;
  totalEvictedCount: number;
}

interface DashboardData {
  memories: MemoriesResponse | null;
  decisions: DecisionsResponse | null;
  listings: ListingsResponse | null;
  economics: EconomicsResponse | null;
  decay: DecayResponse | null;
  loadedAtMs: number | null;
  error: string | null;
}

const EMPTY: DashboardData = {
  memories: null,
  decisions: null,
  listings: null,
  economics: null,
  decay: null,
  loadedAtMs: null,
  error: null,
};

async function loadAll(): Promise<DashboardData> {
  try {
    const [m, d, l, e, dc] = await Promise.all([
      fetch("/api/memories").then((r) => r.json()),
      fetch("/api/decisions").then((r) => r.json()),
      fetch("/api/listings").then((r) => r.json()),
      fetch("/api/economics").then((r) => r.json()),
      fetch("/api/decay").then((r) => r.json()),
    ]);
    return {
      memories: m as MemoriesResponse,
      decisions: d as DecisionsResponse,
      listings: l as ListingsResponse,
      economics: e as EconomicsResponse,
      decay: dc as DecayResponse,
      loadedAtMs: Date.now(),
      error: null,
    };
  } catch (err) {
    return {
      ...EMPTY,
      error: err instanceof Error ? err.message : String(err),
      loadedAtMs: Date.now(),
    };
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function readInitialMode(): ConsoleMode {
  if (typeof window === "undefined") return "ambient";
  try {
    const v = window.localStorage.getItem(MODE_STORAGE_KEY);
    if (v === "dev" || v === "ambient") return v;
  } catch {
    /* localStorage disabled — fall through */
  }
  return "ambient";
}

function App() {
  const [data, setData] = useState<DashboardData>(EMPTY);
  const [inspected, setInspected] = useState<MemoryDetailResponse | null>(null);
  const [inspectErr, setInspectErr] = useState<string | null>(null);
  const [mode, setMode] = useState<ConsoleMode>(() => readInitialMode());

  const onToggleMode = useCallback((next: ConsoleMode) => {
    setMode(next);
    try {
      window.localStorage.setItem(MODE_STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
  }, []);

  // Initial load + polling
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const next = await loadAll();
      if (!alive) return;
      setData(next);
      timer = setTimeout(tick, REFRESH_INTERVAL_MS);
    };
    tick();
    const onVis = () => {
      if (document.visibilityState === "visible" && alive && !timer) tick();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  const inspect = useCallback(async (key: Hex) => {
    setInspectErr(null);
    try {
      const res = await fetch(
        `/api/memories/detail?entityKey=${encodeURIComponent(key)}`,
      );
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`detail ${res.status}: ${txt}`);
      }
      const detail = (await res.json()) as MemoryDetailResponse;
      setInspected(detail);
    } catch (err) {
      setInspectErr(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const inspectMemory = useCallback(
    (m: MemorySummary) => {
      void inspect(m.entityKey);
    },
    [inspect],
  );

  const recentMemories = useMemo(() => {
    if (!data.memories) return [];
    return [...data.memories.memories]
      .sort((a, b) => b.lastEventBlock - a.lastEventBlock)
      .slice(0, 64);
  }, [data.memories]);

  // For ambient mode constellation we want a generous sample; for the dev-mode
  // lifespan list we still cap at 12 (the original behavior) so the bars stay
  // readable.
  const lifespanMemories = useMemo(
    () => recentMemories.slice(0, 12),
    [recentMemories],
  );

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          <a href="/" className="back-link" title="Cortex landing">
            ← Home
          </a>
          <span className="brand-dot" />
          <span>Cortex</span>
          <span className="tag muted">Console</span>
        </div>
        <div className="topbar-right">
          <DevModeToggle mode={mode} onToggle={onToggleMode} />
          <WalletConnect />
        </div>
      </div>

      {data.error ? (
        <div className="card" role="alert">
          <strong>API error.</strong> {data.error}
        </div>
      ) : null}

      {/* ============================================================
       *  AMBIENT — the narrative surface (always rendered)
       * ============================================================ */}

      <AnchorPulse />

      <MemoryConstellation
        memories={recentMemories}
        onInspect={inspectMemory}
      />

      <DecisionTimeline
        decisions={data.decisions?.decisions ?? []}
        onInspectCitation={inspect}
      />

      <AllowanceCard sessionKey={null} master={null} />

      {/* Synaptic Market — keep visible in both modes */}
      <div className="section">
        <div className="section-title">Synaptic Market</div>
        <div className="card">
          {data.listings && data.listings.listings.length > 0 ? (
            data.listings.listings.map((l) => (
              <ListingCard key={l.entityKey} listing={l} />
            ))
          ) : (
            <div className="empty">
              No listings yet. When a rule is published with a GLM price, it
              shows up here for any agent to query.
            </div>
          )}
        </div>
      </div>

      {/* ============================================================
       *  DEV — diagnostic surfaces (rendered when mode === "dev")
       * ============================================================ */}

      {mode === "dev" ? (
        <>
          {/* Trilemma scoreboard */}
          <div className="section">
            <div className="section-title">Trilemma scoreboard</div>
            <div className="trilemma-row">
              <div className="trilemma-tile">
                <div className="label">💰 Cost</div>
                <div className="value">
                  {data.economics
                    ? `${data.economics.avgGasPerMemory.toLocaleString()} gas`
                    : "—"}
                </div>
                <div className="sub">
                  {data.economics
                    ? `avg per memory · ${formatGlm(data.economics.totalGasCostWei)} total`
                    : "loading…"}
                </div>
              </div>
              <div className="trilemma-tile">
                <div className="label">🧠 Cognition</div>
                <div className="value">
                  {data.decisions
                    ? `${data.decisions.decisions.length} decisions`
                    : "—"}
                </div>
                <div className="sub">
                  {data.decisions
                    ? `${data.decisions.decisions.reduce((a, d) => a + d.citedKeys.length, 0)} citations across all act() calls`
                    : "loading…"}
                </div>
              </div>
              <div className="trilemma-tile">
                <div className="label">📦 Storage</div>
                <div className="value">
                  {data.economics
                    ? `${data.economics.compressionRatio.toFixed(1)}×`
                    : "—"}
                </div>
                <div className="sub">
                  {data.economics
                    ? `${formatBytes(data.economics.rawBytesEstimate)} raw → ${formatBytes(data.economics.storedBytesEstimate)} on-chain (RaBitQ)`
                    : "RaBitQ compression loading…"}
                </div>
              </div>
            </div>
          </div>

          {/* Hero stat grid */}
          <div className="section">
            <div className="grid-2">
              <StatCard
                label="Live Memories"
                value={data.memories?.counts.total ?? "—"}
                sub={
                  data.memories ? (
                    <>
                      <span>
                        <span className="dot working" />
                        {data.memories.counts.working} working
                      </span>
                      <span>
                        <span className="dot episodic" />
                        {data.memories.counts.episodic} episodic
                      </span>
                      <span>
                        <span className="dot rule" />
                        {data.memories.counts.rule} rule
                      </span>
                    </>
                  ) : null
                }
              />
              <StatCard
                label="Synaptic GLM"
                value={
                  data.listings
                    ? formatGlm(data.listings.aggregate.totalEarnedWei)
                    : "—"
                }
                sub={
                  data.listings ? (
                    <>
                      <span>
                        {data.listings.aggregate.activeListings} active listings
                      </span>
                      <span>
                        last sale{" "}
                        {data.listings.aggregate.lastSaleAtBlock
                          ? `block #${data.listings.aggregate.lastSaleAtBlock.toLocaleString()}`
                          : "—"}
                      </span>
                    </>
                  ) : null
                }
              />
            </div>
          </div>

          {/* RaBitQ Playground */}
          <RaBitQPlayground onInspectKey={inspect} />

          {/* Proof playground */}
          <ProofPlayground />

          {/* Recently evicted */}
          <div className="section">
            <div className="section-title">
              Recently evicted (free GC)
              {data.decay && data.decay.totalEvictedCount > 0 ? (
                <span className="tag muted" style={{ marginLeft: 8 }}>
                  {data.decay.totalEvictedCount} total
                </span>
              ) : null}
            </div>
            <div className="card">
              {data.decay && data.decay.recentlyEvicted.length > 0 ? (
                <div className="evicted-list">
                  {data.decay.recentlyEvicted.map((e) => (
                    <div
                      key={`${e.entityKey}-${e.blockNumber}`}
                      className="evicted-row"
                    >
                      <span className="key">
                        {truncateAddress(e.entityKey)}
                      </span>
                      <span>
                        block #{e.blockNumber.toLocaleString()} · ~
                        {e.gasReclaimedEstimate.toLocaleString()} gas saved
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="empty">
                  No evictions yet. Useless memories will appear here when
                  Arkiv's L1Block sync sweeps them — no gas paid by you.
                </div>
              )}
            </div>
          </div>

          {/* Raw memory lifespan health bars — kept for side-by-side debug */}
          <div className="section">
            <div className="section-title">Memory Lifespan (raw bars)</div>
            <div className="card">
              {lifespanMemories.length === 0 ? (
                <div className="empty">
                  No live Cortex memories yet. Start the mirror daemon (
                  <code>bun run mirror</code>) and seed via the agent.
                </div>
              ) : (
                lifespanMemories.map((m) => (
                  <MemoryHealthBar
                    key={m.entityKey}
                    memory={m}
                    onInspect={inspectMemory}
                  />
                ))
              )}
            </div>
          </div>
        </>
      ) : null}

      <div
        style={{ textAlign: "center", color: "var(--muted)", fontSize: 12 }}
      >
        {data.loadedAtMs
          ? `updated ${new Date(data.loadedAtMs).toLocaleTimeString()} · polling every 4s · ${mode}`
          : "loading…"}
      </div>

      {inspected ? (
        <div
          className="modal-backdrop"
          onClick={() => setInspected(null)}
          role="presentation"
        >
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <h3>Memory inspector</h3>
            <div className="row">
              <span className="k">key</span>
              <span className="mono">{inspected.summary.entityKey}</span>
            </div>
            <div className="row">
              <span className="k">owner</span>
              <span className="mono">
                {truncateAddress(inspected.summary.owner)}
              </span>
            </div>
            <div className="row">
              <span className="k">creator</span>
              <span className="mono">
                {truncateAddress(inspected.summary.creator)}
              </span>
            </div>
            <div className="row">
              <span className="k">tier</span>
              <span>{inspected.summary.tier}</span>
            </div>
            <div className="row">
              <span className="k">state</span>
              <span>{inspected.summary.state}</span>
            </div>
            <div className="row">
              <span className="k">expires at</span>
              <span>
                block #{inspected.summary.expiresAtBlock.toLocaleString()}
              </span>
            </div>
            <div className="row">
              <span className="k">attributes</span>
              <span>
                {inspected.attributes.map((a) => (
                  <span key={`${a.key}:${a.value}`} className="tag muted">
                    {a.key}: {String(a.value)}
                  </span>
                ))}
              </span>
            </div>
            {inspected.payloadPreview ? (
              <div className="row">
                <span className="k">payload</span>
                <span className="mono" style={{ wordBreak: "break-all" }}>
                  {inspected.payloadPreview}
                </span>
              </div>
            ) : null}
            <div className="close-row">
              <button type="button" onClick={() => setInspected(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {inspectErr ? (
        <div className="card" role="alert" style={{ marginTop: 12 }}>
          <strong>Inspector error.</strong> {inspectErr}
        </div>
      ) : null}
    </div>
  );
}

const container = document.getElementById("root");
if (!container) throw new Error("missing #root container");
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
