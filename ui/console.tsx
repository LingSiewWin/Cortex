/**
 * Cortex — Ambient Dashboard React root.
 *
 * Phase 15: Apple-tier dark theme with thermodynamic memory metaphor
 * (orange = hot working/episodic, blue = cold rules + anchors).
 *
 * Judge mode (default): graph-first layout for judges — MemoryGraph hero,
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
import { GraphHero } from "./components/GraphHero";
import { PluginInstallStrip } from "./components/PluginInstallStrip";
import { LocalFirstPanel } from "./components/LocalFirstPanel";
import { WalletUpload } from "./components/WalletUpload";
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

type ConsoleMode = "judge" | "dev";

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
  if (typeof window === "undefined") return "judge";
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("dev") === "1") return "dev";
  } catch {
    /* ignore */
  }
  try {
    const v = window.localStorage.getItem(MODE_STORAGE_KEY);
    if (v === "dev" || v === "ambient") return "dev";
    if (v && v !== "dev" && v !== "ambient") return "judge";
  } catch {
    /* localStorage disabled — fall through */
  }
  return "judge";
}

function ConsoleApp() {
  const [data, setData] = useState<DashboardData>(EMPTY);
  const [inspected, setInspected] = useState<MemoryDetailResponse | null>(null);
  const [inspectErr, setInspectErr] = useState<string | null>(null);
  const [mode, setMode] = useState<ConsoleMode>(() => readInitialMode());
  const [effectiveOwner, setEffectiveOwner] = useState<Hex | null>(null);
  // null = not yet probed; true = the autonomous loop is configured on this
  // server (local dev); false = no live backend (the serverless deploy state).
  const [loopConfigured, setLoopConfigured] = useState<boolean | null>(null);

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

  // Probe whether this server runs the autonomous loop. On a serverless deploy
  // the loop can never be configured (stateful long-running process), so this
  // stays false and gates the local-first explainer below.
  useEffect(() => {
    let alive = true;
    void fetch("/api/loop/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((s: { configured?: boolean } | null) => {
        if (alive) setLoopConfigured(s?.configured === true);
      })
      .catch(() => {
        if (alive) setLoopConfigured(false);
      });
    return () => {
      alive = false;
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

  // No-live-backend detection (the serverless deploy state). True only once we
  // have probed BOTH signals and both say "dead": the autonomous loop is not
  // configured AND the mirror is empty (zero memories at block 0). While either
  // probe is still pending we do NOT show the explainer — that avoids a flash
  // of the panel on a healthy local-dev load. When the backend is live (loop
  // running OR mirror has data) this is false and the real console renders.
  const noLiveBackend = useMemo(() => {
    if (loopConfigured !== false) return false; // not probed, or loop is live
    const mem = data.memories;
    if (!mem) return false; // memories not loaded yet — don't flash the panel
    return mem.currentBlock === 0 && mem.counts.total === 0;
  }, [loopConfigured, data.memories]);

  if (noLiveBackend) {
    // Public serverless deploy: no loop, empty mirror. Still show the wallet
    // upload — the browser-signed write path (connect → sign → pay GLM gas →
    // measured receipt) needs no backend state, only the embedding key for
    // /api/store-file/prepare. Without this, the deployed console had NO
    // connect-wallet button at all and the on-camera gas proof was unreachable.
    return (
      <div className="cx cx-console">
        <div className="app app-judge">
          <header className="topbar">
            <div className="brand">
              <a href="/" className="back-link mono" title="Cortex landing">
                Home
              </a>
              <span className="brand-dot" aria-hidden />
              <span>Cortex</span>
              <span className="tag muted mono">Console</span>
            </div>
            <div className="topbar-right">
              <span className="tag muted mono">local-first</span>
              <WalletHeader />
            </div>
          </header>
          <ConnectGate
            title="Connect wallet to store on Braga"
            lead="Your wallet signs the Arkiv transaction and pays GLM gas — the measured fee is read back from the on-chain receipt. No server key involved."
          >
            <section className="console-controls" aria-label="Store on Arkiv">
              <WalletUpload />
            </section>
          </ConnectGate>
          <LocalFirstPanel />
        </div>
        <CortexFooter />
      </div>
    );
  }

  return (
    <div className="cx cx-console">
    <>
    <div className={`app${mode === "judge" ? " app-judge" : ""}`}>
      <header className="topbar">
        <div className="brand">
          <a href="/" className="back-link mono" title="Cortex landing">
            Home
          </a>
          <span className="brand-dot" aria-hidden />
          <span>Cortex</span>
          <span className="tag muted mono">Console</span>
        </div>
        <div className="topbar-right">
          <AnchorPill />
          <DevModeToggle mode={mode} onToggle={onToggleMode} />
          <WalletHeader />
        </div>
      </header>

      {data.error ? (
        <div className="card" role="alert">
          <strong>API error.</strong> {data.error}
        </div>
      ) : null}

      {mode === "judge" ? (
        <div className="console-judge">
          <GraphHero
            memoryCounts={data.memories?.counts ?? null}
            compressionRatio={data.economics?.compressionRatio ?? null}
            effectiveOwner={effectiveOwner}
            memoryCount={data.memories?.counts.total ?? null}
          />

          <ConnectGate
            title="Connect wallet to store on Braga"
            lead="Upload seals with your wallet key; you approve one Arkiv transaction and pay GLM gas. The server only embeds text — it never holds your signing key."
          >
            <section className="console-controls" aria-label="Store on Arkiv">
              <WalletUpload
                onStored={() => {
                  void loadAll(effectiveOwner).then(setData);
                }}
              />
            </section>
          </ConnectGate>

          <section className="console-controls console-controls-secondary" aria-label="Agent activity">
            <CitationWidget variant="compact" />
            <PluginInstallStrip />
          </section>
        </div>
      ) : (
        <>
      <div className="two-pane">
        <section className="pane pane-live" aria-label="Live Darwinian engine">

      {mode === "dev" ? (
        <ConnectGate
          title="Connect wallet to store on Braga"
          lead="Same browser upload as judge: your wallet signs the create; GLM pays gas on Braga testnet."
        >
          <div className="section">
            <div className="section-title">Store a file (wallet-signed)</div>
            <WalletUpload
              onStored={() => {
                void loadAll(effectiveOwner).then(setData);
              }}
              onInspectKey={(key) => void inspect(key)}
            />
          </div>
        </ConnectGate>
      ) : null}

      <CitationWidget />

      <div className="section">
        <div className="section-title">Memory topology</div>
        <div className="section-hint">
          The shape of the agent&apos;s memory: each node is a cluster of related
          memories, brightness is remaining lease. Cite one and its cluster
          pulses; let one decay and it cools and drops.
        </div>
        <MemoryGraph surface="light" />
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
            {inspected.summary.entityType ? (
              <div className="row inspector-entity-type">
                <span className="k">type</span>
                <span>
                  <strong className="mono">{inspected.summary.entityType}</strong>
                  {inspected.summary.entityType === "document" ? (
                    <span className="inspector-type-hint">
                      {" "}
                      — wallet upload (full text for .md/.txt; images are hash + caption only)
                    </span>
                  ) : inspected.summary.entityType === "observation" ? (
                    <span className="inspector-type-hint">
                      {" "}
                      — agent fingerprint (~198 B RaBitQ), not a file upload
                    </span>
                  ) : null}
                </span>
              </div>
            ) : null}
            <div className="row">
              <span className="k">key</span>
              <span className="mono">{inspected.summary.entityKey}</span>
            </div>
            <div className="row">
              <span className="k">decay</span>
              <a
                className="mono"
                href={`/decay/${inspected.summary.entityKey}`}
                target="_blank"
                rel="noreferrer"
                title="See this memory's lease climb on citation and decay on neglect"
              >
                view decay receipt →
              </a>
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
            {inspected.text ? (
              <div className="row inspector-readable">
                <span className="k">memory</span>
                <pre className="inspector-text">{inspected.text}</pre>
              </div>
            ) : inspected.payloadPreview ? (
              <div className="row">
                <span className="k">payload</span>
                <span className="mono inspector-preview">
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
    </div>
  );
}

export default ConsoleApp;
