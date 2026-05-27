"use client";

/**
 * Cortex — public landing page (Road A).
 *
 * Editorial / gallery direction: a full-bleed cinematic hero video, monochrome
 * white display type, mono micro-labels, then off-white content bands and one
 * dark "memory lifecycle" band. Live chain numbers (gas, memories alive,
 * compression) are pulled from /api so the page is a live instrument, not a
 * static brochure. "Open Console →" routes to /console for the working app.
 *
 * Plain CSS (ui/landing-editorial.css) + framer-motion. No Tailwind, no 3D —
 * the hero is the provided cinematic loop.
 */

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { formatGlm } from "./format";
import CortexFooter from "./components/CortexFooter";

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

const VIDEO_SRC = "/assets/landing-video.mp4";

// ── motion variants ──────────────────────────────────────────────────────
const EASE = [0.16, 1, 0.3, 1] as const;

const letterBlock = {
  initial: { y: 140, opacity: 0 },
  animate: { y: 0, opacity: 1, transition: { duration: 1.1, ease: EASE } },
};

const fadeUp = {
  initial: { opacity: 0, y: 22 },
  animate: { opacity: 1, y: 0 },
};

// ── the four memory tiers (real Cortex model — see CLAUDE.md) ─────────────
const TIERS = [
  {
    name: "Working",
    meta: "01 · 1-hour lease",
    desc: "Every fresh observation lands here, RaBitQ-compressed and written to Arkiv with a one-hour starting lease. Cheap to make, cheap to lose — most of these will quietly evict.",
  },
  {
    name: "Episodic",
    meta: "02 · +7 days",
    desc: "Cite a working memory twice inside its window and the chain extends its lease — remaining time plus a week. The agent voted with its attention; the memory survives.",
  },
  {
    name: "Semantic",
    meta: "03 · 1-year rule",
    desc: "Cited five times across three sessions, a memory is distilled into a plain-text rule and re-written with a year-long lease. Patterns the agent keeps reaching for become durable knowledge.",
  },
  {
    name: "Cold archive",
    meta: "04 · local mirror",
    desc: "Expired on-chain but never truly gone: a local SQLite mirror caught every event. On a recall miss the memory is re-created on Arkiv from your own data. You own it even if we vanish.",
  },
] as const;

function Wordmark() {
  const letters = "CORTEX".split("");
  return (
    <motion.div
      className="cx-wordmark"
      initial="initial"
      animate="animate"
      transition={{ staggerChildren: 0.06, delayChildren: 0.1 }}
    >
      {letters.map((ch, i) => (
        <motion.span key={i} variants={letterBlock}>
          {ch}
        </motion.span>
      ))}
      <motion.span className="cx-wordmark__dot" variants={letterBlock}>
        ●
      </motion.span>
    </motion.div>
  );
}

function ArrowRight() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function Hero({
  economics,
  memories,
}: {
  economics: EconomicsResponse | null;
  memories: MemoriesResponse | null;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  // Some browsers won't honour the `autoPlay` attribute until nudged; a muted,
  // inline play() on mount is the standard fallback and is a no-op when it
  // already started.
  useEffect(() => {
    videoRef.current?.play().catch(() => {
      /* autoplay blocked — the poster frame still shows */
    });
  }, []);

  return (
    <section className="cx-hero">
      <video
        ref={videoRef}
        className="cx-hero__video"
        src={VIDEO_SRC}
        autoPlay
        loop
        muted
        playsInline
        preload="auto"
      />
      <div className="cx-hero__scrim" />

      <header className="cx-topbar">
        <Wordmark />
        <motion.div
          className="cx-subnav"
          initial="initial"
          animate="animate"
          transition={{ staggerChildren: 0.1, delayChildren: 0.5 }}
        >
          <motion.div className="cx-subnav__col mono" variants={fadeUp}>
            Sovereign
            <br />
            Memory
            <br />
            Engine
          </motion.div>
          <motion.div className="cx-subnav__arrow" variants={fadeUp}>
            <ArrowRight />
          </motion.div>
          <motion.div className="cx-subnav__lead mono" variants={fadeUp}>
            A decay-aware memory for AI agents — compressed, written to Arkiv,
            and reinforced only when the agent actually cites it.
          </motion.div>
          <motion.nav className="cx-subnav__nav mono" variants={fadeUp}>
            <a href="#what">What you get</a>
            <a href="#lifecycle">Lifecycle</a>
            <a href="#install">Install</a>
            <a href="/console">Open Console</a>
          </motion.nav>
        </motion.div>
      </header>

      <div className="cx-hero__body">
        <motion.div
          className="cx-hero__lead"
          initial="initial"
          animate="animate"
          transition={{ staggerChildren: 0.12, delayChildren: 0.7 }}
        >
          <motion.div className="cx-index mono" variants={fadeUp}>
            01<span className="cx-index__rule" />
          </motion.div>
          <motion.h1 className="cx-hero__headline" variants={fadeUp}>
            Memory that earns
            <br />
            its rent.
            <span className="cx-hero__sub">Owned by your wallet.</span>
          </motion.h1>
          <motion.p className="cx-hero__desc" variants={fadeUp}>
            Other agent-memory products treat storage lifespan as a budget.
            Cortex treats it as a fitness function. Cite a memory in a real
            decision and the chain extends its lease — useful memories grow,
            useless ones evict for free.
          </motion.p>
          <motion.div variants={fadeUp}>
            <a className="cx-btn" href="/console">
              <span className="cx-btn__fill" />
              <span>Open Console</span>
              <ArrowRight />
            </a>
          </motion.div>
        </motion.div>

        <motion.aside
          className="cx-specimen"
          variants={fadeUp}
          initial="initial"
          animate="animate"
          transition={{ delay: 1.1, duration: 0.8, ease: "easeOut" }}
        >
          <div className="cx-specimen__kicker mono">Live on Braga</div>
          <div className="cx-specimen__title">
            Decay-aware memory, measured per block on Arkiv's testnet.
          </div>
          <div className="cx-stat">
            <div className="cx-stat__label mono">Memories alive</div>
            <div className="cx-stat__value">
              <span className="cx-alive" />
              {memories ? memories.counts.total : "—"}
            </div>
          </div>
          <div className="cx-stat">
            <div className="cx-stat__label mono">Gas / memory</div>
            <div className="cx-stat__value">
              {economics ? economics.avgGasPerMemory.toLocaleString() : "—"}
            </div>
          </div>
          <div className="cx-stat">
            <div className="cx-stat__label mono">Compression</div>
            <div className="cx-stat__value">
              {economics ? `${economics.compressionRatio.toFixed(1)}×` : "—"}
            </div>
          </div>
        </motion.aside>
      </div>

      <motion.div
        className="cx-scroll mono"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 1.4, duration: 0.8 }}
      >
        <div className="cx-scroll__dot">
          <div className="cx-scroll__bar" />
        </div>
        Scroll to explore
      </motion.div>
    </section>
  );
}

function Statement() {
  const pills = [
    "Forgets what it doesn't use",
    "Owned by your wallet",
    "Plugs into your agent",
  ];
  return (
    <section className="cx-band" id="what">
      <div className="cx-label mono">
        <span className="cx-label__n">[ 02 ]</span>
        <b>What you get</b>
      </div>
      <motion.h2
        className="cx-statement__heading"
        initial={{ opacity: 0, y: 36 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-100px" }}
        transition={{ duration: 0.9, ease: EASE }}
      >
        A memory that decays like a brain, costs cents per session, and{" "}
        <em>stays yours</em> even if our backend disappears.
      </motion.h2>
      <motion.div
        className="cx-pills"
        initial="initial"
        whileInView="animate"
        viewport={{ once: true, margin: "-80px" }}
        transition={{ staggerChildren: 0.1, delayChildren: 0.2 }}
      >
        {pills.map((p) => (
          <motion.span
            key={p}
            className="cx-pill"
            variants={fadeUp}
            transition={{ duration: 0.6, ease: EASE }}
          >
            {p}
          </motion.span>
        ))}
      </motion.div>
    </section>
  );
}

function Lifecycle() {
  const [active, setActive] = useState(0);
  // auto-cycle through the tiers, like the reference's chapter list
  useEffect(() => {
    const i = setInterval(() => setActive((p) => (p + 1) % TIERS.length), 4200);
    return () => clearInterval(i);
  }, []);
  const ring = TIERS[active]!;

  return (
    <section className="cx-band cx-dark" id="lifecycle">
      <div className="cx-label mono">
        <span className="cx-label__n">[ 03 ]</span>
        <b>The memory lifecycle</b>
      </div>
      <div className="cx-life">
        <div className="cx-life__stage">
          <div className="cx-life__counter mono">
            <b>{String(active + 1).padStart(2, "0")}</b> / {String(TIERS.length).padStart(2, "0")}
          </div>
          <div className="cx-life__glyph">
            <div
              className="cx-life__ring"
              style={{
                // the ember arc sweeps further as the tier matures
                ["--sweep" as string]: `${(active + 1) * 90}deg`,
              }}
            >
              <AnimatePresence mode="wait">
                <motion.div
                  key={ring.name}
                  className="cx-life__ttl"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.4, ease: EASE }}
                >
                  <b>{ring.name}</b>
                  {ring.meta.split("·")[1]?.trim()}
                </motion.div>
              </AnimatePresence>
            </div>
          </div>
          <div className="cx-life__counter mono">Reinforced on citation</div>
        </div>

        <div className="cx-life__list">
          {TIERS.map((t, i) => (
            <div
              key={t.name}
              className="cx-life__row"
              data-active={i === active}
              onMouseEnter={() => setActive(i)}
              onClick={() => setActive(i)}
            >
              <div className="cx-life__rowhead">
                <span className="cx-life__name">{t.name}</span>
                <AnimatePresence initial={false}>
                  {i === active && (
                    <motion.p
                      className="cx-life__desc"
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.45, ease: EASE }}
                    >
                      {t.desc}
                    </motion.p>
                  )}
                </AnimatePresence>
              </div>
              <span className="cx-life__meta">{t.meta}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Install() {
  return (
    <section className="cx-band" id="install">
      <div className="cx-label mono">
        <span className="cx-label__n">[ 04 ]</span>
        <b>Install — your AI never forgets your project</b>
      </div>
      <div className="cx-grid2">
        <div className="cx-cell">
          <h3>1 · Add it to Claude Code (once)</h3>
          <p>
            Cortex ships as a Claude Code plugin. Two commands, then it
            auto-loads in every session — no flags, no manual steps.
          </p>
          <pre className="cx-code">
{`# in Claude Code:
/plugin marketplace add LingSiewWin/Cortex
/plugin install cortex-memory`}
          </pre>
          <p>
            Requires <code>bun</code>. Then just run <code>claude</code> — at
            session start it recalls your project&apos;s memory; as you work it
            captures decisions to Arkiv before the context compacts and forgets.
          </p>
        </div>
        <div className="cx-cell">
          <h3>2 · Point it at your wallet (sovereign by design)</h3>
          <p>
            Memories are sealed with a key derived from your wallet and written
            to Arkiv — owned by you, not us. Set these in your environment:
          </p>
          <pre className="cx-code">
{`SESSION_KEY_PRIVATE_KEY=0x…   # signs Arkiv writes (pays GLM gas)
CORTEX_USER_SIGNATURE=0x…     # derives your encryption key
OPENROUTER_API_KEY=…          # embeddings (or COHERE_API_KEY)`}
          </pre>
          <p>
            Need test GLM?{" "}
            <a href="https://braga.hoodi.arkiv.network/faucet/" target="_blank" rel="noreferrer">
              Braga faucet
            </a>
            . Prefer to watch first?{" "}
            <a href="/console">Open the live console →</a>
          </p>
        </div>
      </div>
    </section>
  );
}

function Economics({ economics, memories }: { economics: EconomicsResponse | null; memories: MemoriesResponse | null }) {
  return (
    <section className="cx-band">
      <div className="cx-label mono">
        <span className="cx-label__n">[ 05 ]</span>
        <b>The trilemma — measured on Braga</b>
      </div>
      <div className="cx-tri">
        <div className="cx-tri__cell">
          <div className="cx-tri__label mono">Cost per memory</div>
          <div className="cx-tri__value">
            {economics ? economics.avgGasPerMemory.toLocaleString() : "—"}
          </div>
          <div className="cx-tri__sub">
            {economics
              ? `${formatGlm(economics.totalGasCostWei)} total · ${economics.entityCount} entities`
              : "loading…"}
          </div>
        </div>
        <div className="cx-tri__cell">
          <div className="cx-tri__label mono">Memories alive</div>
          <div className="cx-tri__value">{memories ? memories.counts.total : "—"}</div>
          <div className="cx-tri__sub">
            {memories
              ? `${memories.counts.working} working · ${memories.counts.episodic} episodic · ${memories.counts.rule} rule`
              : "loading…"}
          </div>
        </div>
        <div className="cx-tri__cell">
          <div className="cx-tri__label mono">Compression</div>
          <div className="cx-tri__value">
            {economics ? `${economics.compressionRatio.toFixed(1)}×` : "—"}
          </div>
          <div className="cx-tri__sub">
            {economics
              ? `${economics.rawBytesEstimate.toLocaleString()} B raw → ${economics.storedBytesEstimate.toLocaleString()} B on-chain`
              : "loading…"}
          </div>
        </div>
      </div>

      <div className="cx-prose" style={{ marginTop: "clamp(48px, 8vh, 96px)" }}>
        <p>
          Arkiv prices storage as <strong>bytes × lifetime</strong>: cheap for
          tiny things briefly, expensive for large things forever. Agent
          embeddings are large by default (1,536 dimensions × 4 bytes = 6 KB
          each) and want to live as long as they&apos;re useful.
        </p>
        <p>
          Cortex closes the gap from both ends. <strong>RaBitQ</strong>{" "}
          compresses each embedding to ~200 bytes. <strong>Accumulative
          extend</strong> only spends gas to keep memories the agent actually
          cites. Together they make the unit economics of on-chain agent memory
          genuinely viable.
        </p>
        <p className="cx-muted">
          This is the demonstration vehicle for Arkiv&apos;s broader thesis:
          time-scoped storage + queryable attributes + compression = agent
          infrastructure that doesn&apos;t bankrupt anyone.
        </p>
      </div>
    </section>
  );
}

function Honest() {
  return (
    <section className="cx-band" style={{ paddingTop: 0 }}>
      <div className="cx-label mono">
        <span className="cx-label__n">[ 06 ]</span>
        <b>Honest trust assumptions</b>
      </div>
      <div className="cx-prose">
        <ul>
          <li>
            <strong>v1 relayer is trusted.</strong> A backend EOA holds the
            session key, bounded by an EIP-712 SessionAuthorization (max writes,
            validBefore, entityNamespace). v2 migrates to EIP-7702 when Braga
            supports it.
          </li>
          <li>
            <strong>The memory market is deferred, not shipped.</strong> A
            trustless agent-to-agent market needs on-chain escrow + atomic
            pay-to-decrypt, which Braga (precompile-only, no contract
            deployment) can&apos;t host yet. It&apos;s a documented future layer.
          </li>
          <li>
            <strong>Semantic-tier lifespan capped at 1 year.</strong> Not 5/250
            years. Arkiv&apos;s fee model is unresolved — we ship short and
            migrate when it lands.
          </li>
          <li>
            <strong>No &quot;trustless&quot; / &quot;fully decentralised&quot;
            claims.</strong> Arkiv launches with centralised sequencers. We
            market what&apos;s true, not what&apos;s aspirational.
          </li>
        </ul>
      </div>
    </section>
  );
}

export function Landing() {
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
        /* ignore — landing degrades gracefully */
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
    <div className="cx">
      <Hero economics={economics} memories={memories} />
      <Statement />
      <Lifecycle />
      <Install />
      <Economics economics={economics} memories={memories} />
      <Honest />
      <CortexFooter />
    </div>
  );
}
