/**
 * Cortex — local-first explainer panel.
 *
 * Shown on the public web surface when there is no live backend: the
 * autonomous loop is not configured AND the SQLite mirror is empty (the state
 * a serverless deploy is permanently stuck in). Instead of a silently-empty
 * dashboard, a public visitor sees an honest explainer: Cortex has no backend —
 * it runs locally in Claude Code via the plugin (or `bun run dev`). Install
 * steps + Loom walkthrough as proof.
 *
 * When the loop IS running / the mirror HAS data (local dev), the console
 * renders the real dashboard and this panel never mounts.
 */

import { useCallback, useState } from "react";

const VIDEO_URL =
  "https://www.loom.com/share/68178caad4034e8282ac412a440e0738";

const INSTALL_CMD = `/plugin marketplace add LingSiewWin/Cortex
/plugin install cortex-memory
cortex auth`;

export function LocalFirstPanel() {
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(() => {
    navigator.clipboard
      ?.writeText(INSTALL_CMD)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      })
      .catch(() => {
        /* clipboard blocked (non-secure context / denied) — fail silently */
      });
  }, []);

  return (
    <section className="local-first" aria-label="Cortex runs locally">
      <div className="local-first-hero">
        <span className="local-first-eyebrow mono">No backend by design</span>
        <h2 className="local-first-title">
          Cortex runs <span className="local-first-accent">locally</span>, in
          your agent.
        </h2>
        <p className="local-first-lead">
          There is no server you depend on. The product is the Claude Code
          plugin: the MCP server runs on your machine over stdio via{" "}
          <code>bun</code>, the SQLite mirror lives on your disk, and Arkiv
          writes are signed by your own funded session key. This deployment is a
          landing surface — so it shows an empty console here instead of
          pretending to run an autonomous loop it cannot host.
        </p>
      </div>

      <div className="local-first-grid">
        <div className="local-first-cell local-first-install">
          <div className="local-first-cell-head">
            <span className="mono">Install in Claude Code</span>
            <button
              type="button"
              className="local-first-copy"
              onClick={onCopy}
              aria-label={copied ? "Install commands copied" : "Copy install commands"}
            >
              <span aria-live="polite">{copied ? "copied ✓" : "copy"}</span>
            </button>
          </div>
          <pre className="local-first-code">{INSTALL_CMD}</pre>
          <p className="local-first-hint">
            Sign once with your wallet, fund the printed session key on the{" "}
            <a
              href="https://braga.hoodi.arkiv.network/faucet/"
              target="_blank"
              rel="noreferrer"
            >
              Braga faucet
            </a>
            , then recall and cite memory from any session. Requires{" "}
            <code>bun</code> on your PATH.
          </p>
        </div>

        <div className="local-first-cell local-first-watch">
          <div className="local-first-cell-head">
            <span className="mono">See it run</span>
          </div>
          <p className="local-first-hint">
            The autonomous loop and live console below are for local development
            (<code>bun run dev</code>). Watch the walkthrough to see the
            Darwinian memory engine reinforcing and decaying memory on Braga.
          </p>
          <a
            className="local-first-watch-btn"
            href={VIDEO_URL}
            target="_blank"
            rel="noreferrer"
          >
            <span className="local-first-play" aria-hidden>
              ▶
            </span>
            Watch the walkthrough
          </a>
        </div>
      </div>

      <p className="local-first-foot mono">
        Running it yourself? <code>bun run seed</code> →{" "}
        <code>bun run dev</code> brings this console fully alive.
      </p>
    </section>
  );
}
