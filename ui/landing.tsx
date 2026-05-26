/**
 * Cortex — public landing page (Road A).
 *
 * Investor / judge / dev surface. Read-only. Tells the thesis in 30 seconds.
 * "Open Console →" routes to /console for the actual working dashboard.
 *
 * Live numbers pulled from /api/economics and /api/memories so the page is
 * not a static brochure — visitors see the chain math happening in real time.
 */

import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { formatGlm } from "./format";
import MemoryHero from "./components/MemoryHero/MemoryHero";

interface EconomicsResponse {
  totalGasUnits: number;
  totalGasCostWei: string;
  entityCount: number;
  avgGasPerMemory: number;
  rawBytesEstimate: number;
  storedBytesEstimate: number;
  compressionRatio: number;
  uncompressedGasCostWei: string;
  monthlyProjectionWei: string;
}

interface MemoriesResponse {
  currentBlock: number;
  counts: {
    total: number;
    working: number;
    episodic: number;
    rule: number;
    other: number;
  };
}

function Landing() {
  const [economics, setEconomics] = useState<EconomicsResponse | null>(null);
  const [memories, setMemories] = useState<MemoriesResponse | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const [e, m] = await Promise.all([
          fetch("/api/economics").then((r) => r.json()),
          fetch("/api/memories").then((r) => r.json()),
        ]);
        if (!alive) return;
        setEconomics(e as EconomicsResponse);
        setMemories(m as MemoriesResponse);
      } catch {
        /* ignore — landing page degrades gracefully */
      }
    };
    tick();
    const i = setInterval(tick, 10_000);
    return () => {
      alive = false;
      clearInterval(i);
    };
  }, []);

  return (
    <div className="landing">
      {/* 3D interactive hero — chrome memory tower + data field + jellyfish energy source */}
      <MemoryHero />

      <nav className="landing-nav">
        <div className="brand">
          <span className="brand-dot" />
          <span>Cortex</span>
        </div>
        <div className="landing-nav-right">
          <a href="https://github.com/Arkiv-Network/arkiv-ethns-builder-challenge" target="_blank" rel="noreferrer">
            ETHNS Challenge
          </a>
          <a href="/console" className="cta">
            Open Console →
          </a>
        </div>
      </nav>

      <header className="hero">
        <h1>
          Darwinian memory for AI agents.<br />
          <span className="muted">On Arkiv. Owned by your wallet.</span>
        </h1>
        <p className="lede">
          Most agent-memory products treat storage lifespan as a budget.
          Cortex treats it as a fitness function. When the agent cites a
          memory in a real decision, the chain extends its lease. Useful
          memories grow; useless ones evict for free.
        </p>
        <div className="hero-cta">
          <a href="/console" className="cta primary">
            Open Console →
          </a>
          <a
            href="https://explorer.braga.hoodi.arkiv.network/"
            className="cta secondary"
            target="_blank"
            rel="noreferrer"
          >
            Live on Braga
          </a>
        </div>
      </header>

      {/* What you actually get — plain language, BEFORE any protocol jargon. */}
      <section className="section">
        <div className="section-title">What you get</div>
        <div className="grid-3">
          <div className="card wedge">
            <h3>🧠 Forgets what it doesn&apos;t use</h3>
            <p>
              Like a brain. Each time your agent acts on a memory, that memory
              lives longer; the ones it never uses fade out on their own. No
              manual cleanup, no paying to store junk forever.
            </p>
          </div>
          <div className="card wedge">
            <h3>🔑 You own it — survives us shutting down</h3>
            <p>
              Memories are encrypted with your wallet and live on a public
              chain, not our servers. Delete our backend entirely and rebuild
              every memory from the chain with just your wallet. Without the
              wallet, they&apos;re unreadable.
            </p>
          </div>
          <div className="card wedge">
            <h3>🔌 Built to plug into your agent</h3>
            <p>
              An{" "}
              <a href="https://github.com/openclaw/openclaw" target="_blank" rel="noreferrer">
                OpenClaw
              </a>
              -compatible memory adapter: <code>memory_store</code> / <code>memory_recall</code>.
              Spec-compliant and validated against Braga; live-gateway integration is the next step.
            </p>
          </div>
        </div>
      </section>

      {/* Live trilemma scoreboard — pulled from real chain data */}
      <section className="section">
        <div className="section-title">Live trilemma — measured on Braga</div>
        <div className="grid-3">
          <div className="card stat">
            <div className="stat-label">💰 Cost per memory</div>
            <div className="stat-value">
              {economics ? `${economics.avgGasPerMemory.toLocaleString()} gas` : "—"}
            </div>
            <div className="stat-sub">
              {economics
                ? `${formatGlm(economics.totalGasCostWei)} total · ${economics.entityCount} entities`
                : "loading…"}
            </div>
          </div>
          <div className="card stat">
            <div className="stat-label">🧠 Memories alive</div>
            <div className="stat-value">
              {memories ? memories.counts.total : "—"}
            </div>
            <div className="stat-sub">
              {memories
                ? `${memories.counts.working} working · ${memories.counts.episodic} episodic · ${memories.counts.rule} rule`
                : "loading…"}
            </div>
          </div>
          <div className="card stat">
            <div className="stat-label">📦 Compression</div>
            <div className="stat-value">
              {economics ? `${economics.compressionRatio.toFixed(1)}×` : "—"}
            </div>
            <div className="stat-sub">
              {economics
                ? `${economics.rawBytesEstimate.toLocaleString()} B raw → ${economics.storedBytesEstimate.toLocaleString()} B on-chain`
                : "loading…"}
            </div>
          </div>
        </div>
      </section>

      {/* The four wedges */}
      <section className="section">
        <div className="section-title">Why Cortex wins on Arkiv</div>
        <div className="grid-2">
          <div className="card wedge">
            <h3>1 · Darwinian reinforcement</h3>
            <p>
              Cited memories <strong>accumulate</strong> lifespan (not REPLACE).
              The chain's <code>extend</code> primitive becomes long-term
              potentiation — the only Arkiv project that uses it as a learned
              fitness signal, not a renewal cron.
            </p>
          </div>
          <div className="card wedge">
            <h3>2 · Hierarchical ownership</h3>
            <p>
              Working memories die with the session (biologically correct).
              Promoted memories transfer ownership from session-key to user
              EOA — tamper-proof attribution stays on{" "}
              <code>$creator</code>, long-term control belongs to the human.
            </p>
          </div>
          <div className="card wedge">
            <h3>3 · OpenClaw-compatible adapter</h3>
            <p>
              Cortex exposes <code>memory-arkiv</code>, an adapter for
              OpenClaw&apos;s single memory slot — aiming to make a local-only
              assistant&apos;s memory portable, verifiable, and wallet-owned.
              Spec-compliant; not yet run inside a live gateway.
            </p>
          </div>
          <div className="card wedge">
            <h3>4 · Self-host via ERC-5169</h3>
            <p>
              The mirror replay script is published as{" "}
              <code>scriptURI()</code> on a tiny registry. A judge who
              deletes our backend can rebuild Cortex from chain events with
              just their wallet. <strong>Sovereign by construction.</strong>
            </p>
          </div>
        </div>
      </section>

      {/* What the trilemma actually solves */}
      <section className="section">
        <div className="section-title">The trilemma we offload from Arkiv</div>
        <div className="card prose">
          <p>
            Arkiv shipped a chain whose pricing model is{" "}
            <strong>bytes × lifetime</strong>. That makes it cheap if you
            store tiny things briefly, expensive if you store large things
            forever. Agent embeddings are{" "}
            <em>large by default</em> (1,536 dimensions × 4 bytes = 6 KB
            each) and want to live as long as they're useful.
          </p>
          <p>
            We close the gap from both ends. <strong>RaBitQ</strong>{" "}
            compresses each embedding to ~200 bytes (31× smaller).{" "}
            <strong>Accumulative extend</strong> only spends gas to keep
            memories the agent actually cites. The combination makes the
            unit economics of on-chain agent memory genuinely viable for
            the first time.
          </p>
          <p className="muted">
            This is the demonstration vehicle for Arkiv's broader thesis:
            time-scoped storage + queryable attributes + compression =
            agent infrastructure that doesn't bankrupt anyone.
          </p>
        </div>
      </section>

      {/* Honest disclosure */}
      <section className="section">
        <div className="section-title">Honest trust assumptions</div>
        <div className="card prose small">
          <ul>
            <li>
              <strong>v1 relayer is trusted.</strong> A backend EOA holds
              the session key, bounded by EIP-712 SessionAuthorization
              (max writes, validBefore, entityNamespace). v2 migrates to
              EIP-7702 when Braga supports it.
            </li>
            <li>
              <strong>The memory market is deferred, not shipped.</strong> A
              trustless agent-to-agent market needs on-chain escrow + atomic
              pay-to-decrypt, which Braga (precompile-only, no contract
              deployment — we verified this) can&apos;t host yet. We don&apos;t
              claim it works; it&apos;s a documented future layer.
            </li>
            <li>
              <strong>Semantic-tier lifespan capped at 1 year.</strong> Not
              5/250 years. Arkiv's fee model is unresolved — we ship short
              and migrate when it lands.
            </li>
            <li>
              <strong>No "trustless" / "fully decentralised" claims.</strong>{" "}
              Arkiv launches with centralised sequencers. We market what's
              true, not what's aspirational.
            </li>
          </ul>
        </div>
      </section>

      <footer className="landing-footer">
        <div>
          Submission for the{" "}
          <a
            href="https://forms.arkiv.network/ethns-arkiv-challenge"
            target="_blank"
            rel="noreferrer"
          >
            Arkiv × ETHNS Builder Challenge
          </a>{" "}
          · Theme: AI + Privacy
        </div>
        <div className="muted">
          Built with Bun · viem · @arkiv-network/sdk@0.6.8 · React 19 ·
          bun:sqlite
        </div>
      </footer>
    </div>
  );
}

const container = document.getElementById("root");
if (!container) throw new Error("missing #root container");
createRoot(container).render(
  <StrictMode>
    <Landing />
  </StrictMode>,
);
