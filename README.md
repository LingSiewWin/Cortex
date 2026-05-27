# Cortex

![Cortex landing page — Darwinian memory for AI agents on Arkiv Braga](./assets/landing-page.png)

> **Darwinian memory for AI agents** — observations that earn longer expiration when
> cited; useless ones decay for free on Arkiv. Encrypted at rest with a key derived
> from your wallet. _(AI + Privacy · Arkiv × ETHNS Builder Challenge)_

| | Link |
|---|------|
| **Deploy (Vercel)** | https://cortex-arkiv.vercel.app |
| **Console** | https://cortex-arkiv.vercel.app/console |
| **Video walkthrough** | https://www.loom.com/share/68178caad4034e8282ac412a440e0738 |
| **Source** | https://github.com/LingSiewWin/Cortex |
| **Chain** | [Arkiv Braga testnet](https://explorer.braga.hoodi.arkiv.network/) · chainId `60138453102` |

One repo — not a monorepo. `app/` + `src/` + `cortex-plugin/` ship together.

---

## What it does

| Layer | Behavior |
|--------|----------|
| **Write** | RaBitQ-compress embeddings (1536-d → ~198 B), seal payload with wallet-derived AES-256-GCM, `createEntity` on Braga with **1 h** starting expiration |
| **Recall** | Hybrid search: Arkiv attributes + local mirror + RaBitQ distance — no vector DB |
| **Reinforce** | Every `act(..., citations=[...])` fires **accumulative** `extend` (remaining lease + 24 h), so useful memories grow; stale ones evict via L1Block |
| **Prove** | Merkle Mountain Range over decisions; roots **anchored on Arkiv** |

Agent surface: **`recall(query, k)`** and **`act(action, citations[])`** only.

### Live console (`/console`)

An autonomous loop (server session key) recalls and cites on a timer; each step emits typed events on **`/sse`**. The UI shows Braga tx links, topology graph, and manual query/cite. **File upload** uses your **browser wallet** on Braga (prepare on server → sign tx in MetaMask).

---

## Claude Code plugin

![Cortex console — wallet upload and MCP / OpenClaw integrate panel](./assets/plug-in.png)

**Marketplace (Claude Code):**

```text
/plugin marketplace add LingSiewWin/Cortex
/plugin install cortex-memory
cortex auth
```

![Claude Code — marketplace install and cortex auth in the terminal](./assets/claude-plugin-auth.png)

Verified flow: marketplace add → `cortex-memory` install → `cortex auth` writes `~/.cortex/config.json` (owner wallet + session key). Fund the printed session key on [Braga faucet](https://braga.hoodi.arkiv.network/faucet/) before Arkiv writes.

`cortex auth` opens a local page — keep the terminal open until you sign. Requires **`bun`** on your PATH.

**From a clone** (after `bun run build:plugin`):

```bash
claude plugin install --plugin-dir ./cortex-plugin
```

- **Hooks:** capture before compaction, recall at session start
- **MCP:** `cortex_recall`, `cortex_act`, `cortex_store_document` on stdio (`bun run mcp` from repo root)
- **Skill:** `cortex-memory` usage patterns

Config templates: `cortex-plugin/.mcp.json`, `hooks/hooks.json`. See [`cortex-plugin/README.md`](./cortex-plugin/README.md).

---

## Quick start

```bash
git clone https://github.com/LingSiewWin/Cortex.git
cd Cortex
bun install
cp .env.example .env
```

Fill `.env` (see [Environment](#environment)). Then:

```bash
bun run faucet-check    # session key has GLM on Braga
bun run seed            # seed memories (run once, before the loop)
bun run dev             # http://localhost:3000  →  /console
```

| Script | Purpose |
|--------|---------|
| `bun run dev` | Next.js dev server (landing + console + `/api/*`) |
| `bun run build` / `start` | Production Next.js |
| `bun test` | Full test suite (353+ tests) |
| `bun run smoke` | Single real Braga create + read |
| `bun run mirror` | Standalone mirror replay daemon |
| `bun run mcp` | Cortex MCP server (stdio) |
| `bun run build:plugin` | Bundle Claude Code plugin to `cortex-plugin/dist/` |

See **[scripts/README.md](./scripts/README.md)** for the full script list (Braga scripts & eval are optional).

> Run **`seed` before** starting the loop — seed and the autonomous agent share one session-key EOA; parallel writes collide on nonce.

---

## Environment

| Variable | Required | Role |
|----------|----------|------|
| `SESSION_KEY_PRIVATE_KEY` | Writes / loop | `$creator` session-key EOA (fund via [faucet](https://braga.hoodi.arkiv.network/faucet/)) |
| `USER_PRIMARY_ADDRESS` | Ownership | `$owner` primary EOA |
| `CORTEX_USER_SIGNATURE` or `CORTEX_USER_PRIVATE_KEY` | Sealed recall | Wallet-derived payload key (see `bun scripts/derive-user-signature.ts`) |
| `OPENROUTER_API_KEY` or `COHERE_API_KEY` | Embeddings | 1536-d vectors for RaBitQ (upload + recall) |
| `ANTHROPIC_API_KEY` | Optional | Semantic distillation |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | Optional | Reown AppKit modal; omit → injected MetaMask only |
| `NEXT_PUBLIC_BRAGA_RPC` | Optional | Default: Braga HTTP RPC from `src/constants.ts` |
| `CORTEX_MIRROR_PATH` | Optional | SQLite mirror path (default `./cortex-mirror.sqlite`) |

---

## Architecture

End-to-end on Arkiv Braga (renders on GitHub or [mermaid.live](https://mermaid.live)).

```mermaid
sequenceDiagram
  autonumber
  participant UI as Browser console
  participant Wallet as Owner wallet
  participant API as Cortex API
  participant OR as Embeddings API
  participant Engine as RaBitQ recall seal
  participant Mirror as SQLite mirror
  participant Agent as Session key creator
  participant Chain as Arkiv Braga
  participant SSE as SSE stream

  Note over UI,Chain: Write path wallet signs 1h lease
  UI->>API: store-file prepare
  API->>OR: embedText descriptor
  OR-->>API: 1536-d embedding
  API-->>UI: RaBitQ and attributes
  UI->>Wallet: sign key derivation
  UI->>UI: AES-GCM seal payload
  Wallet->>Chain: mutateEntities
  Chain-->>Mirror: ingest events
  Mirror-->>SSE: graph and RPC ticker

  Note over Agent,Chain: Reinforce cite in act or decay
  Agent->>Engine: recall query k
  Engine->>Mirror: hybrid rank
  Engine->>Chain: query attributes
  Engine-->>Agent: memory IDs
  Agent->>Engine: act with citations
  Engine->>Chain: extendEntity remaining plus 24h
  Engine->>Chain: anchor MMR root
  Engine-->>SSE: memory.cited and arkiv.rpc

  Note over Chain: Uncited memories evict via L1Block
```

**Ownership:** `$creator` = session key (attribution); `$owner` = your wallet (extend/update/delete). Reads filter by creator + `project=cortex-ethns-2026`.

**Tiers:** working (1h) → episodic (≥2 cites, +7d) → semantic (≥5 cites · 3 sessions, 1y rule).

**Extend math:** `newBtl = remaining + reinforcement` (strict increase — naïve `+24h` reverts when remaining > 24 h).

---

## Stack

- **Web:** Next.js 15 (App Router), React 19, Reown AppKit, wagmi, viem
- **Runtime:** Bun (tests, scripts, plugin); Node on Vercel (API + `better-sqlite3`)
- **Chain:** Arkiv Braga — chainId `60138453102`, SDK `@arkiv-network/sdk` ^0.6.8
- **Compression:** RaBitQ @ 1536-d
- **Identity:** EIP-712 session auth, SIWE, ERC-5267 domain, browser-signed Braga writes

---

## Repo map

```
|__
|___ app/              Next.js — `/`, `/console`, `/api/[[...path]]`, `/sse`
|___ lib/web/          AppKit, connect gate, browser upload hook
|___ ui/               Landing, console, MemoryGraph, upload UI
|___ src/
|    |___ lib/         Arkiv client, crypto, sealing, Braga preflight
|    |___ compression/ RaBitQ, embeddings, document payloads
|    |___ darwinian/    extend, recall, citation, distill
|    |___ mirror/      SQLite schema, replay, MMR, anchor, evict watcher
|    |___ topology/    Graph builder for `/api/topology`
|    |___ api/         HTTP handlers (auth, store-file, seed, …)
|    |___ agent/       Autonomous loop, anchor worker
|    |___ mcp/         MCP server for agent tooling
|    |___ obsidian/    Vault → mirror sync
|___ cortex-plugin/    Claude Code plugin (hooks, MCP, skills)
|___ scripts/          seed, cite-flow, sovereignty-proof, plugin build
|___ tests/            Offline + smoke/canary against Braga
|___ contracts/        CortexRegistry.sol (+ SynapticMarket.sol deferred on Braga)
```

---

## Sovereignty proof

`bun scripts/sovereignty-proof.ts` · [Braga round-trip](https://explorer.braga.hoodi.arkiv.network/tx/0x6c391af1fa9f9faa952b793980e2b657b33d724298b15a4b7e5fc174543828a2)

---

## Reference

| | Link |
|---|------|
| **Explorer** | https://explorer.braga.hoodi.arkiv.network/ |
| **Faucet** | https://braga.hoodi.arkiv.network/faucet/ |
| **RPC** | `https://braga.hoodi.arkiv.network/rpc` |

### RaBitQ (embedding compression)

Cortex stores **1-bit RaBitQ** codes (1536-d → ~198 B) for recall distance estimates. Implementation is in `src/compression/rabitq.ts` + `fht.ts` (TypeScript; not the NTU C++ library).

**Citation (SIGMOD 2024):** Gao et al., *RaBitQ: Quantizing High-Dimensional Vectors with a Theoretical Error Bound*, [arXiv:2405.12497](https://arxiv.org/abs/2405.12497) · [RaBitQ-Library](https://github.com/VectorDB-NTU/RaBitQ-Library) (Apache-2.0). Deeper notes: [`docs/RabitQ.md`](./docs/RabitQ.md).

---

## License

MIT — see [`LICENSE`](./LICENSE).
