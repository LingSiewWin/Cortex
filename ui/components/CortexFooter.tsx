/**
 * CortexFooter — shared liquid-glass footer for the landing + console.
 *
 * A frosted "liquid glass" panel floating over a dimmed, blurred reprise of the
 * hero's cosmic loop — the page opens and closes on the same cosmos. Link
 * groups render as ASCII box-drawing trees (├── └──) in JetBrains Mono, in
 * keeping with the editorial / technical voice of the rest of the site.
 *
 * Self-contained: all styling lives in CortexFooter.css under the `.cxf`
 * scope, so the component drops onto either surface (light landing or dark
 * console) and always renders its own dark, atmospheric band.
 */

import { motion } from "framer-motion";
import "./CortexFooter.css";

// A static still (not the hero loop) keeps the footer — and the video-less
// console — light and fast to paint.
const BACKDROP_SRC = "/assets/landing-footer.png";

interface LinkItem {
  label: string;
  href: string;
  external?: boolean;
}

interface LinkGroup {
  heading: string;
  items: LinkItem[];
}

// Real links — sourced from docs/landing-page/footer-info.md.
const GROUPS: LinkGroup[] = [
  {
    heading: "Connect",
    items: [
      { label: "X", href: "https://x.com/siewwwin", external: true },
      { label: "Telegram", href: "https://t.me/siewwwin", external: true },
      { label: "GitHub", href: "https://github.com/LingSiewWin", external: true },
    ],
  },
  {
    heading: "Build",
    items: [
      { label: "Open Console", href: "/console" },
      { label: "Install", href: "/#install" },
      { label: "Cortex repo", href: "https://github.com/LingSiewWin/Cortex", external: true },
    ],
  },
  {
    heading: "Arkiv",
    items: [
      {
        label: "ETHNS Challenge",
        href: "https://github.com/Arkiv-Network/arkiv-ethns-builder-challenge",
        external: true,
      },
      { label: "Braga Faucet", href: "https://braga.hoodi.arkiv.network/faucet/", external: true },
      { label: "Explorer", href: "https://explorer.braga.hoodi.arkiv.network/", external: true },
    ],
  },
];

function extraProps(item: LinkItem) {
  return item.external ? { target: "_blank", rel: "noreferrer" } : {};
}

function TreeColumn({ group }: { group: LinkGroup }) {
  const last = group.items.length - 1;
  return (
    <div className="cxf-col">
      <div className="cxf-col__head mono">{group.heading}</div>
      <ul className="cxf-tree">
        {group.items.map((item, i) => (
          <li key={item.label} className="cxf-tree__row">
            <span className="cxf-tree__branch mono" aria-hidden>
              {i === last ? "└──" : "├──"}
            </span>
            <a className="cxf-tree__link" href={item.href} {...extraProps(item)}>
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── inline social marks (no icon dependency) ──────────────────────────────
function IconX() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}
function IconTelegram() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.479.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
    </svg>
  );
}
function IconGitHub() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.5 11.5 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.91 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222 0 1.606-.014 2.898-.014 3.293 0 .322.216.694.825.576C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

export function CortexFooter() {
  return (
    <footer className="cxf">
      <img
        className="cxf__bg"
        src={BACKDROP_SRC}
        alt=""
        aria-hidden
        loading="lazy"
        decoding="async"
      />
      <div className="cxf__scrim" />

      <motion.div
        className="cxf__glass liquid-glass"
        initial={{ opacity: 0, y: 40 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-80px" }}
        transition={{ duration: 1, delay: 0.1, ease: "easeOut" }}
      >
        <div className="cxf__grid">
          <div className="cxf__brand">
            <div className="cxf__wordmark">
              Cortex<span className="cxf__dot">●</span>
            </div>
            <p className="cxf__tagline">
              Sovereign, decay-aware memory for AI agents. Owned by your wallet,
              archived on Arkiv.
            </p>
          </div>
          <div className="cxf__cols">
            {GROUPS.map((g) => (
              <TreeColumn key={g.heading} group={g} />
            ))}
          </div>
        </div>

        <div className="cxf__bar">
          <span className="cxf__by mono">Built by @siewwwin</span>
          <div className="cxf__social">
            <span className="cxf__follow mono">Follow →</span>
            <a href="https://x.com/siewwwin" target="_blank" rel="noreferrer" aria-label="X">
              <IconX />
            </a>
            <a href="https://t.me/siewwwin" target="_blank" rel="noreferrer" aria-label="Telegram">
              <IconTelegram />
            </a>
            <a
              href="https://github.com/LingSiewWin/Cortex"
              target="_blank"
              rel="noreferrer"
              aria-label="GitHub"
            >
              <IconGitHub />
            </a>
          </div>
        </div>
      </motion.div>
    </footer>
  );
}

export default CortexFooter;
