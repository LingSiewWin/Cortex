/**
 * Cortex — Developer Hub (Pane 2).
 *
 * Static "show & tell" for the two integration surfaces that expose Cortex's
 * memory engine to other runtimes:
 *   - MCP Server   — `cortex_recall` / `cortex_act` over stdio for any MCP client
 *                    (Claude Desktop, Cursor, Cline…). Real server in src/mcp/.
 *   - OpenClaw     — fills OpenClaw's single memory slot (`memory_store` /
 *                    `memory_recall`). Manifest in extensions/memory-arkiv/.
 *
 * Intentionally presentational: no integration logic runs here. It shows the
 * real tool schemas and the actual quick-start commands so a judge can copy and
 * run them. Schemas/commands are sourced from the shipped code (not invented):
 * src/mcp/server.ts and extensions/memory-arkiv/{openclaw.plugin.json,README.md}.
 */

import { useCallback, useState } from "react";

type Tab = "MCP Server" | "OpenClaw Plugin";
const TABS: Tab[] = ["MCP Server", "OpenClaw Plugin"];

interface ToolSpec {
  signature: string;
  desc: string;
}

const MCP_TERMINAL = `# Cortex MCP server — sovereign, decay-aware memory
# for any MCP client (Claude Desktop · Cursor · Cline)

# from a clone of https://github.com/LingSiewWin/Cortex (requires bun):
$ git clone https://github.com/LingSiewWin/Cortex.git && cd Cortex
$ bun install && bun run build:plugin
$ bun run mcp
  ▸ tools: cortex_recall, cortex_act, cortex_store_document
  ▸ transport: stdio · Arkiv Braga (chain 60138453102)

# Claude Code: /plugin install cortex-memory then cortex auth`;

const OPENCLAW_TERMINAL = `# Cortex memory plugin for OpenClaw —
# replaces the local memory slot with a portable, verifiable backend

$ openclaw plugins install --link ./extensions/memory-arkiv
$ openclaw gateway restart
$ openclaw plugins inspect memory-arkiv --runtime --json
  ▸ memory-arkiv registered (preferOver: memory-core)
  ▸ tools: memory_store, memory_recall`;

const MCP_TOOLS: ToolSpec[] = [
  {
    signature: "cortex_recall(query: string, k?: number)",
    desc: "Semantic recall over your decay-aware memory. Returns the top-k candidate memory IDs with previews — the set a later cite is validated against.",
  },
  {
    signature: "cortex_act(action: string, citations: string[])",
    desc: "Record a decision and cite the memories it used. Each citation fires an accumulative lease extension (remaining + reinforcement) — cited memories survive, the rest decay for free.",
  },
  {
    signature: "cortex_store_document(text, title?, vaultPath?)",
    desc: "Document Tier: seal a full note's TEXT + embeddings to Arkiv with a durable lease — recoverable from your wallet alone (lossless), not just a fingerprint. For Obsidian notes / long-form you want to own sovereignly.",
  },
];

const OPENCLAW_TOOLS: ToolSpec[] = [
  {
    signature: "memory_store(content, metadata?)",
    desc: "Sealed write to Arkiv: RaBitQ-compressed, wallet-encrypted, written with a 1-hour starting lease. Mirrored locally for sovereignty.",
  },
  {
    signature: "memory_recall(query, k?)",
    desc: "Decay-aware recall from the wallet-owned store. Citing a recalled memory in a decision reinforces its lease.",
  },
];

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(() => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }, [text]);
  return (
    <button type="button" className="devhub-copy" onClick={onCopy} aria-label="Copy commands">
      {copied ? "copied ✓" : "copy"}
    </button>
  );
}

export function DeveloperHub() {
  const [tab, setTab] = useState<Tab>("MCP Server");
  const terminal = tab === "MCP Server" ? MCP_TERMINAL : OPENCLAW_TERMINAL;
  const tools = tab === "MCP Server" ? MCP_TOOLS : OPENCLAW_TOOLS;

  return (
    <div className="devhub">
      <div className="devhub-head">
        <div className="section-title">Integrate Cortex</div>
        <div className="section-hint">
          The same engine you&apos;re watching on the left, exposed to any agent
          runtime. Drop sovereign, decay-aware memory into your stack.
        </div>
      </div>

      <div className="devhub-tabs" role="tablist" aria-label="Integration surface">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={t === tab}
            className={`devhub-tab${t === tab ? " active" : ""}`}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="terminal">
        <div className="terminal-bar">
          <span className="terminal-light r" />
          <span className="terminal-light y" />
          <span className="terminal-light g" />
          <span className="terminal-title mono">
            {tab === "MCP Server" ? "cortex-mcp" : "openclaw + cortex"}
          </span>
          <CopyButton text={terminal} />
        </div>
        <pre className="terminal-body mono">{terminal}</pre>
      </div>

      <div className="devhub-schema">
        <div className="devhub-schema-title mono">Tools exposed</div>
        {tools.map((t) => (
          <div key={t.signature} className="devhub-tool">
            <code className="devhub-tool-sig">{t.signature}</code>
            <div className="devhub-tool-desc">{t.desc}</div>
          </div>
        ))}
      </div>

      <div className="devhub-foot section-hint">
        {tab === "MCP Server" ? (
          <>
            Status: <strong>runnable</strong> — minimal server wrapping the same
            <code> recall</code> / <code>act</code> primitives the live engine uses.
          </>
        ) : (
          <>
            Status: <strong>schema-complete</strong> — manifest + tool surface
            validated against Braga; install links the plugin into a local gateway.
          </>
        )}
      </div>
    </div>
  );
}
