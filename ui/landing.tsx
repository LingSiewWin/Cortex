"use client";

/**
 * Cortex — public landing page.
 *
 * Editorial hero + product-accurate copy. Landing shows static Braga economics
 * framing plus live RaBitQ compression from /api/economics — not per-visitor
 * memory counts.
 */

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import CortexFooter from "./components/CortexFooter";
import { ConsoleLink } from "./components/ConsoleLink";
import { PixelWaveProvider } from "./components/PixelWaveProvider";
import { BRAGA } from "@/src/constants";

const VIDEO_SRC = "/assets/landing-video.mp4";

interface EconomicsResponse {
  rawBytesEstimate: number;
  storedBytesEstimate: number;
  compressionRatio: number;
}

const EASE = [0.16, 1, 0.3, 1] as const;

const letterBlock = {
  initial: { y: 140, opacity: 0 },
  animate: { y: 0, opacity: 1, transition: { duration: 1.1, ease: EASE } },
};

const fadeUp = {
  initial: { opacity: 0, y: 22 },
  animate: { opacity: 1, y: 0 },
};

const TIERS = [
  {
    name: "Working",
    meta: "01 · 1-hour lease",
    desc: "New observations start here: RaBitQ-compressed, sealed, written to Arkiv. Uncited memories expire within about an hour.",
  },
  {
    name: "Episodic",
    meta: "02 · +7 days",
    desc: "Cited at least twice inside the working window → lease extends to remaining time plus seven days.",
  },
  {
    name: "Semantic",
    meta: "03 · 1-year rule",
    desc: "Cited five times across three sessions → distilled to a plain-text rule and re-written with a one-year lease.",
  },
  {
    name: "Cold archive",
    meta: "04 · local mirror",
    desc: "After on-chain expiration, your SQLite mirror still holds the event log. Recall can re-create from your copy.",
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

function ArrowLeft() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M19 12H5M11 6l-6 6 6 6" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function Hero() {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    videoRef.current?.play().catch(() => {});
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
        <motion.div
          className="cx-topbar__row"
          initial="initial"
          animate="animate"
          transition={{ staggerChildren: 0.08, delayChildren: 0.1 }}
        >
          <Wordmark />
          <motion.div variants={fadeUp}>
            <ConsoleLink className="cx-topbar-cta">
              <ArrowLeft />
              <span>Open Console</span>
            </ConsoleLink>
          </motion.div>
        </motion.div>
        <motion.p
          className="cx-topbar__tagline mono"
          variants={fadeUp}
          initial="initial"
          animate="animate"
          transition={{ delay: 0.45, duration: 0.7, ease: EASE }}
        >
          Sovereign memory engine — decay-aware agent memory on Arkiv, compressed,
          cited to survive, encrypted with your wallet.
        </motion.p>
        <motion.h1
          className="cx-hero__headline cx-topbar__headline"
          variants={fadeUp}
          initial="initial"
          animate="animate"
          transition={{ delay: 0.55, duration: 0.85, ease: EASE }}
        >
          Darwinian memory
          <br />
          for AI agents
          <span className="cx-hero__sub">Owned by your wallet.</span>
        </motion.h1>
      </header>

      <div className="cx-hero__body">
        <motion.div
          className="cx-hero__lead"
          initial="initial"
          animate="animate"
          transition={{ staggerChildren: 0.12, delayChildren: 0.65 }}
        >
          <motion.p className="cx-hero__desc" variants={fadeUp}>
            Observations are RaBitQ-compressed and sealed before they reach Braga.
            When an agent cites a memory in a decision, Cortex extends its
            expiration. What never gets cited decays — no manual cleanup.
          </motion.p>
        </motion.div>

        <motion.aside
          className="cx-specimen"
          variants={fadeUp}
          initial="initial"
          animate="animate"
          transition={{ delay: 1.1, duration: 0.8, ease: "easeOut" }}
        >
          <div className="cx-specimen__kicker mono">Arkiv Braga</div>
          <p className="cx-specimen__title">
            Connect your wallet in the console to write and recall your own
            memories on testnet.
          </p>
          <ul className="cx-specimen__links mono">
            <li>
              <ConsoleLink>Console →</ConsoleLink>
            </li>
            <li>
              <a href={BRAGA.faucet} target="_blank" rel="noreferrer">
                GLM faucet ↗
              </a>
            </li>
            <li>
              <a href={BRAGA.explorer} target="_blank" rel="noreferrer">
                Explorer ↗
              </a>
            </li>
          </ul>
        </motion.aside>
      </div>

      <motion.a
        href="#what"
        className="cx-scroll"
        aria-label="Scroll to content"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 1.4, duration: 0.8 }}
      >
        <div className="cx-scroll__dot">
          <div className="cx-scroll__bar" />
        </div>
      </motion.a>
    </section>
  );
}

function Statement() {
  const pills = [
    "recall(query, k)",
    "act(action, citations[])",
    "Wallet-derived encryption",
  ];
  return (
    <section className="cx-band" id="what">
      <div className="cx-label mono">
        <span className="cx-label__n">[ 01 ]</span>
        <b>What you get</b>
      </div>
      <motion.h2
        className="cx-statement__heading"
        initial={{ opacity: 0, y: 36 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-100px" }}
        transition={{ duration: 0.9, ease: EASE }}
      >
        Memories that behave like human memory — forget like humans do.
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
  useEffect(() => {
    const i = setInterval(() => setActive((p) => (p + 1) % TIERS.length), 4200);
    return () => clearInterval(i);
  }, []);
  const ring = TIERS[active]!;

  return (
    <section className="cx-band cx-dark" id="lifecycle">
      <div className="cx-label mono">
        <span className="cx-label__n">[ 02 ]</span>
        <b>Memory lifecycle</b>
      </div>
      <div className="cx-life">
        <div className="cx-life__stage">
          <div className="cx-life__counter mono">
            <b>{String(active + 1).padStart(2, "0")}</b> / {String(TIERS.length).padStart(2, "0")}
          </div>
          <div className="cx-life__glyph">
            <div
              className="cx-life__ring"
              style={{ ["--sweep" as string]: `${(active + 1) * 90}deg` }}
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
          <div className="cx-life__counter mono">Extends on citation</div>
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
        <span className="cx-label__n">[ 03 ]</span>
        <b>Install</b>
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
            Requires <code>bun</code>. At session start it recalls your
            project&apos;s memory; as you work it captures to Arkiv before
            context compacts.
          </p>
        </div>
        <div className="cx-cell">
          <h3>2 · Point it at your wallet</h3>
          <p>
            Memories are sealed with a key derived from your wallet and written
            to Arkiv — owned by you, not us.
          </p>
          <pre className="cx-code">
{`SESSION_KEY_PRIVATE_KEY=0x…   # signs Arkiv writes (pays GLM gas)
CORTEX_USER_SIGNATURE=0x…     # derives your encryption key
OPENROUTER_API_KEY=…          # embeddings (or COHERE_API_KEY)`}
          </pre>
          <p>
            Need test GLM?{" "}
            <a href={BRAGA.faucet} target="_blank" rel="noreferrer">
              Braga faucet
            </a>
            . Prefer to watch first?{" "}
            <ConsoleLink>Open the live console →</ConsoleLink>
          </p>
        </div>
      </div>
    </section>
  );
}

function Economics({ economics }: { economics: EconomicsResponse | null }) {
  return (
    <section className="cx-band" id="economics">
      <div className="cx-label mono">
        <span className="cx-label__n">[ 04 ]</span>
        <b>On Braga testnet</b>
      </div>
      <div className="cx-tri">
        <div className="cx-tri__cell">
          <div className="cx-tri__label mono">Cost per memory</div>
          <div className="cx-tri__value">Ultra-low</div>
          <div className="cx-tri__sub">
            GLM gas on Braga testnet · priced as bytes × expiration, not flat
            storage rent
          </div>
        </div>
        <div className="cx-tri__cell">
          <div className="cx-tri__label mono">Your memory</div>
          <div className="cx-tri__value">Privacy</div>
          <div className="cx-tri__sub">
            Wallet-owned on Arkiv — connect in the console to see your graph,
            tiers, and recall
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
              : "RaBitQ · 1536-d embeddings"}
          </div>
        </div>
      </div>
    </section>
  );
}

const ARKIV_DIAGRAM = `      ◇
     ╱ ╲
    ╱6KB╲
    ╲   ╱
     ╲ ╱
      │
      ◆
   ┌─────┐
   │200B │
   └──┬──┘
      │ cite
   ┌──▼──┐
   │ ext │
   └─────┘`;

const TRUST_DIAGRAM = `  ┌─────────┐
  │ session │─┐
  │  EIP712 │ │
  └─────────┘ │
        ┌─────▼─────┐
        │  wallet   │
        │  $owner   │
        └─────┬─────┘
              │◇
          ┌───▼───┐
          │ AES   │
          └───────┘`;

function ProtocolGrid() {
  return (
    <section className="cx-band cx-protocol" id="protocol">
      <div className="cx-protocol__frame">
        <article className="cx-protocol__card">
          <header className="cx-protocol__head mono">
            <span className="cx-label__n">[ 05 ]</span>
            <b>How it fits Arkiv</b>
          </header>
          <div className="cx-protocol__body">
            <pre className="cx-protocol__ascii mono" aria-hidden>
              {ARKIV_DIAGRAM}
            </pre>
            <div className="cx-prose cx-prose--card">
              <p>
                Arkiv stores <strong>bytes × lifetime</strong>. Agent embeddings are
                naturally large (~6 KB each at full float width). Cortex stores a
                RaBitQ-compressed fingerprint (~200 B) plus attributes, and only pays
                to <strong>extend</strong> entities the agent cites — accumulative
                extend, not a naive “add 24 hours”.
              </p>
              <p>
                Payloads are encrypted client-side; Braga holds ciphertext. Your local
                SQLite mirror catches every event so you can rebuild if a host goes
                away — see <code>bun scripts/sovereignty-proof.ts</code>.
              </p>
            </div>
          </div>
        </article>

        <article className="cx-protocol__card">
          <header className="cx-protocol__head mono">
            <span className="cx-label__n">[ 06 ]</span>
            <b>Trust assumptions</b>
          </header>
          <div className="cx-protocol__body">
            <pre className="cx-protocol__ascii mono" aria-hidden>
              {TRUST_DIAGRAM}
            </pre>
            <div className="cx-prose cx-prose--card">
              <ul>
                <li>
                  <strong>Session-key relayer.</strong> The autonomous loop signs with
                  a backend session key, bounded by EIP-712 SessionAuthorization. Your
                  wallet remains <code>$owner</code>.
                </li>
                <li>
                  <strong>Browser uploads are yours.</strong> File store and key
                  adoption use your wallet on Braga; we never hold your derivation
                  secret.
                </li>
                <li>
                  <strong>Semantic tier capped at one year.</strong> Until Arkiv&apos;s
                  fee model is final, we do not promise multi-year leases.
                </li>
                <li>
                  <strong>No “fully decentralised” marketing.</strong> Braga is a
                  testnet with operated infrastructure. We describe what ships today.
                </li>
              </ul>
            </div>
          </div>
        </article>
      </div>
    </section>
  );
}

export function Landing() {
  const [economics, setEconomics] = useState<EconomicsResponse | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/economics");
        if (!r.ok || !alive) return;
        setEconomics((await r.json()) as EconomicsResponse);
      } catch {
        /* static fallbacks in Economics */
      }
    };
    load();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <PixelWaveProvider>
      <div className="cx">
        <Hero />
        <Statement />
        <Lifecycle />
        <Install />
        <Economics economics={economics} />
        <ProtocolGrid />
        <CortexFooter />
      </div>
    </PixelWaveProvider>
  );
}
