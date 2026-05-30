# Cortex Memory — Claude Code plugin

Make every Claude Code coding session a **memory node**, auto-saved to
[Arkiv](https://arkiv.network) and recalled the next time you open the project.

Your AI stops re-explaining itself. The chain is the engine (sovereign,
decay-aware, wallet-owned); the experience is "your AI never forgets your
project."

## What it does

- **`SessionStart` → recall.** When you start (or resume/clear) a session, the
  plugin resolves the project from your repo's `git remote origin`, recalls this
  project's top memories from Arkiv, and injects a short
  `Cortex recalls for <project>:` block into the session. It also retries any
  summaries from earlier sessions whose write to Arkiv failed.
- **`PreCompact` + `SessionEnd` → capture.** Before the context window compacts
  (and when the session ends), the plugin reads the conversation transcript,
  deterministically extracts your goals + the assistant's decisions into a
  concise summary, and stores it as one durable, provenance-stamped Arkiv
  memory. This is **best-effort and never blocks** your session — if a wallet or
  embedding provider isn't configured, the summary is queued locally and retried
  on the next session start.
- **MCP tools during work.** Bundles the Cortex MCP server so the assistant can
  `cortex_recall`, `cortex_act` (cite + reinforce), `cortex_store_document`, and
  `cortex_summarize_session` mid-session. The bundled **Cortex Memory** skill
  teaches the assistant the recall → cite → store working agreement.

Memories that get cited grow their lease (accumulative extend); memories that go
unused decay for free. Same wallet → same key → a fresh machine can re-sync and
decrypt your memory from the public Arkiv RPC. No key escrow.

## Install

### Marketplace (recommended)

In Claude Code:

```text
/plugin marketplace add LingSiewWin/Cortex
/plugin install cortex-memory
cortex auth
```

Fund the printed session key on the [Braga faucet](https://braga.hoodi.arkiv.network/faucet/) before Arkiv writes. Requires **`bun`** on your PATH.

### From a clone

```bash
git clone https://github.com/LingSiewWin/Cortex.git
cd Cortex
bun install
bun run build:plugin
claude plugin install --plugin-dir ./cortex-plugin
cortex auth
```

Or point Claude Code at it directly when launching:

```bash
claude --plugin-dir ./cortex-plugin
```

The plugin ships self-contained **dist** bundles for hooks, MCP, and auth
(`dist/cortex-hook-*.js`, `dist/cortex-mcp.js`, `dist/cortex-auth.js`) — marketplace
installs do not need the sibling `../src` tree at runtime. Clone-based installs must
run `bun run build:plugin` to produce those bundles.

**MCP without the plugin:** `bun run mcp` from the repo root (stdio server for Cursor
and other MCP clients).

## Required environment

Capture/recall degrade gracefully — without these, summaries queue locally and
sealed memories simply don't surface (no crash). To actually write to and read
from Arkiv:

| Variable | Purpose | Required for |
|---|---|---|
| `CORTEX_USER_SIGNATURE` | 65-byte EIP-191 signature of the Cortex key-derivation message. The only secret a fresh machine needs to derive the seal key (no private key in-process). Generate with `bun scripts/derive-user-signature.ts`. | Sealing/opening memories (recall + store) |
| `CORTEX_USER_PRIVATE_KEY` | Dev alternative to the above: your **primary** EOA key, signed in-process. Use one or the other. | Sealing/opening memories |
| `OPENROUTER_API_KEY` *or* `COHERE_API_KEY` | Embedding provider (1536-d). Required to embed text for storage and recall. | Embeddings |
| `SESSION_KEY_PRIVATE_KEY` | Ephemeral session-key EOA that signs the Arkiv write transaction. | Writing to Braga |
| `USER_PRIMARY_ADDRESS` | Owner EOA, used by `cortex_act` to attribute tier promotions. | `cortex_act` |
| `CORTEX_PLUGIN_DATA_DIR` | Optional. Where queued/pending summaries live. Default: `~/.cortex/plugin`. | — |

Bun auto-loads `.env`, so a `.env` at the repo root is the simplest setup.

## Safety / design notes

- Hooks **always exit 0** and are time-boxed — a capture/recall failure can
  never hang or crash your coding session.
- `PreCompact` cannot delay compaction, so capture is async/best-effort with a
  local pending queue + retry-on-next-start.
- The capture hook does **not** call an LLM — extraction is deterministic and
  offline, so it stays fast.
- Project identity is `git remote origin` (normalized to `host/owner/repo`),
  falling back to the working-directory basename for non-git projects.
