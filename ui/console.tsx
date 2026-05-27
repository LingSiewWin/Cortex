/**
 * Cortex — Ambient Dashboard React root.
 *
 * Phase 15: Apple-tier dark theme with thermodynamic memory metaphor
 * (orange = hot working/episodic, blue = cold rules + anchors).
 *
 * Demo mode (default): graph-first layout for judges — MemoryGraph hero,
 * compact agent bar, install strip. Dev mode (?dev=1): full diagnostics +
 * developer hub sidebar.
 *
 * The agent is a background process; this page reads the SQLite mirror
 * via the JSON API in src/ui-server.ts and surfaces live state.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ConnectGate } from "@/lib/web/components/ConnectGate";
import { WalletHeader } from "@/lib/web/components/WalletHeader";
import { StatCard } from "./components/StatCard";
import { MemoryHealthBar } from "./components/MemoryHealthBar";
import { DeveloperHub } from "./components/DeveloperHub";
import { RaBitQPlayground } from "./components/RaBitQPlayground";
import { AllowanceCard } from "./components/AllowanceCard";
import { ProofPlayground } from "./components/ProofPlayground";
import { DemoHero } from "./components/DemoHero";
import { DemoInstallStrip } from "./components/DemoInstallStrip";
import { DemoUpload } from "./components/DemoUpload";
import MemoryGraph from "./components/MemoryGraph/MemoryGraph";
import { DecisionTimeline } from "./components/DecisionTimeline";
import { DevModeToggle } from "./components/DevModeToggle";
import { CitationWidget } from "./components/CitationWidget";
import { AnchorPill } from "./components/AnchorPill";
import { RPCTicker } from "./components/RPCTicker";
import { RaBitQTile } from "./components/RaBitQTile";
import { MMRTreePanel } from "./components/MMRTreePanel";
import CortexFooter from "./components/CortexFooter";
import { formatGlm, truncateAddress } from "./format";
import type {
  DecisionsResponse,
  Hex,
  MemoriesResponse,
  MemoryDetailResponse,
  MemorySummary,
} from "./types";

const REFRESH_INTERVAL_MS = 4_000;
const MODE_STORAGE_KEY = "cortex_console_mode";

type ConsoleMode = "demo" | "dev";

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
  economics: EconomicsResponse | null;
  decay: DecayResponse | null;
  loadedAtMs: number | null;
  error: string | null;
}

const EMPTY: DashboardData = {
  memories: null,
  decisions: null,
  economics: null,
  decay: null,
  loadedAtMs: null,
  error: null,
};

async function loadAll(owner: Hex | null): Promise<DashboardData> {
  const ownerQs = owner ? `?owner=${encodeURIComponent(owner)}` : "";
  try {
    const [m, d, e, dc] = await Promise.all([
      fetch(`/api/memories${ownerQs}`).then((r) => r.json()),
      fetch("/api/decisions").then((r) => r.json()),
      fetch("/api/economics").then((r) => r.json()),
      fetch("/api/decay").then((r) => r.json()),
    ]);
    return {
      memories: m as MemoriesResponse,
      decisions: d as DecisionsResponse,
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
  if (typeof window === "undefined") return "demo";
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("dev") === "1") return "dev";
  } catch {
    /* ignore */
  }
  try {
    const v = window.localStorage.getItem(MODE_STORAGE_KEY);
    if (v === "dev" || v === "ambient") return "dev";
    if (v === "demo") return "demo";
  } catch {
    /* localStorage disabled — fall through */
  }
  return "demo";
}

function ConsoleApp() {
  const [data, setData] = useState<DashboardData>(EMPTY);
  const [inspected, setInspected] = useState<MemoryDetailResponse | null>(null);
  const [inspectErr, setInspectErr] = useState<string | null>(null);
  const [mode, setMode] = useState<ConsoleMode>(() => readInitialMode());
  const [effectiveOwner, setEffectiveOwner] = useState<Hex | null>(null);

  const onToggleMode = useCallback((next: ConsoleMode) => {
    try {
      window.localStorage.setItem(MODE_STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
    window.location.href = next === "dev" ? "/console?dev=1" : "/console";
  }, []);

  // Effective owner — server-side identity (env or browser-adopted). Used to
  // scope /api/memories and parameterise AllowanceCard. Polled (not just set
  // on connect) so adoption from another tab also picks up here.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch("/api/auth/me");
        if (!r.ok) return;
        const me = (await r.json()) as { ownerAddress: Hex | null };
        if (alive) {
          setEffectiveOwner(me.ownerAddress ?? null);
        }
      } catch {
        /* dashboard degrades gracefully */
      }
    };
    tick();
    const i = setInterval(tick, 8_000);
    return () => {
      alive = false;
      clearInterval(i);
    };
  }, []);

  // Initial load + polling. Re-runs when effectiveOwner changes so the scoped
  // /api/memories result swaps as soon as adoption completes.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const next = await loadAll(effectiveOwner);
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
  }, [effectiveOwner]);

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
    <>
    <div className={`app${mode === "demo" ? " app-demo" : ""}`}>
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
          <AnchorPill />
          {mode === "dev" ? (
            <>
              <DevModeToggle mode={mode} onToggle={onToggleMode} />
              <a href="/console" className="demo-dev-link">
                Demo view
              </a>
            </>
          ) : (
            <a href="/console?dev=1" className="demo-dev-link muted">
              Developer view
            </a>
          )}
          <WalletHeader />
        </div>
      </div>

      {data.error ? (
        <div className="card" role="alert">
          <strong>API error.</strong> {data.error}
        </div>
      ) : null}

      {mode === "demo" ? (
        <ConnectGate>
        <div className="console-demo">
          <DemoHero
            memoryCounts={data.memories?.counts ?? null}
            compressionRatio={data.economics?.compressionRatio ?? null}
            effectiveOwner={effectiveOwner}
            memoryCount={data.memories?.counts.total ?? null}
            onSeeded={() => {
              void loadAll(effectiveOwner).then(setData);
            }}
          />

          <section className="demo-controls" aria-label="Agent controls">
            <DemoUpload
              onStored={() => {
                void loadAll(effectiveOwner).then(setData);
              }}
            />
            <CitationWidget variant="compact" />
            <DemoInstallStrip />
          </section>
        </div>
        </ConnectGate>
      ) : (
        <>
      {mode === "dev" ? (
        <div className="dev-banner mono">
          Developer view — full diagnostics.{" "}
          <a href="/console">Return to demo layout</a>
        </div>
      ) : null}

      {mode === "dev" ? (
        <SeedBanner
          effectiveOwner={effectiveOwner}
          memoryCount={data.memories?.counts.total ?? null}
          onSeeded={() => {
            void loadAll(effectiveOwner).then(setData);
          }}
        />
      ) : null}

      <div className="two-pane">
        <section className="pane pane-live" aria-label="Live Darwinian engine">

      <CitationWidget />

      <div className="section">
        <div className="section-title">Memory topology</div>
        <div className="section-hint">
          The shape of the agent&apos;s memory: each node is a cluster of related
          memories, brightness is remaining lease. Cite one and its cluster
          pulses; let one decay and it cools and drops.
        </div>
        <MemoryGraph />
      </div>

      <div className="spine-grid">
        <RPCTicker />
        <RaBitQTile />
        <MMRTreePanel />
        <AllowanceCard sessionKey={null} master={effectiveOwner} />
      </div>

      <DecisionTimeline
        decisions={(data.decisions?.decisions ?? []).slice(0, 5)}
        onInspectCitation={inspect}
      />

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
            <StatCard
              label="Live Memories"
              value={data.memories?.counts.total ?? "—"}
              sub={
                data.memories ? (
                  <>
                    <span>
                      <span className="dot working" />
                      {data.memories.counts.working} fresh
                    </span>
                    <span>
                      <span className="dot episodic" />
                      {data.memories.counts.episodic} reinforced
                    </span>
                    <span>
                      <span className="dot rule" />
                      {data.memories.counts.rule} core
                    </span>
                  </>
                ) : null
              }
            />
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

        </section>

        {/* ───────── PANE 2 — DEVELOPER HUB (integration show & tell) ───────── */}
        <aside className="pane pane-dev" aria-label="Developer hub">
          <DeveloperHub />
        </aside>
      </div>
        </>
      )}

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
    <CortexFooter />
    </>
  );
}

interface SeedBannerProps {
  effectiveOwner: Hex | null;
  memoryCount: number | null;
  onSeeded: () => void;
}

/**
 * "Your wallet has no memories yet — seed 20 to wake the loop" banner.
 *
 * Only renders when an adopted wallet (effectiveOwner != null) currently owns
 * zero Cortex memories. After a successful seed, the parent re-fetches and the
 * banner self-dismisses (memoryCount > 0).
 */
function SeedBanner({ effectiveOwner, memoryCount, onSeeded }: SeedBannerProps) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [seededTx, setSeededTx] = useState<string | null>(null);

  if (!effectiveOwner) return null;
  if (memoryCount === null) return null;
  if (memoryCount > 0 && !seededTx) return null;

  async function seed() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/seed-memories", { method: "POST" });
      if (!res.ok) {
        throw new Error(await res.text());
      }
      const body = (await res.json()) as { txHash: string; count: number };
      setSeededTx(body.txHash);
      onSeeded();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="card"
      style={{
        margin: "12px 0",
        padding: 16,
        border: "1px solid var(--accent-orange, #FF5A00)",
        background: "rgba(255, 90, 0, 0.06)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 320px" }}>
          <strong>This wallet has no memories yet.</strong>{" "}
          <span style={{ color: "var(--muted)" }}>
            Seed 20 starter observations under your address so the autonomous
            loop has something to recall + cite. Single Arkiv tx; the loop
            picks them up within ~20s.
          </span>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={seed}
          style={{
            padding: "10px 18px",
            background: "var(--accent-orange, #FF5A00)",
            color: "#000",
            border: 0,
            borderRadius: 6,
            fontWeight: 600,
            cursor: busy ? "wait" : "pointer",
            minWidth: 160,
          }}
        >
          {busy ? "Seeding…" : "Seed memories"}
        </button>
      </div>
      {err ? (
        <div style={{ marginTop: 10, color: "var(--accent-red, #ff5050)" }}>
          {err}
        </div>
      ) : null}
      {seededTx ? (
        <div style={{ marginTop: 10, color: "var(--muted)", fontSize: 12 }}>
          ✓ tx{" "}
          <a
            href={`https://explorer.braga.hoodi.arkiv.network/tx/${seededTx}`}
            target="_blank"
            rel="noreferrer"
            className="mono"
          >
            {seededTx.slice(0, 18)}…
          </a>
        </div>
      ) : null}
    </div>
  );
}

export default ConsoleApp;
