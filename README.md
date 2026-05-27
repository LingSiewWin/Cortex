# Cortex

> **Darwinian memory for AI agents** — observations that earn longer expiration when
> cited; useless ones decay for free on Arkiv. Encrypted at rest with a key derived
> from your wallet. _(AI + Privacy · Arkiv × ETHNS Builder Challenge)_

| | Link |
|---|------|
| **Deploy (Vercel)** | https://cortex-arkiv.vercel.app |
| **Console** | https://cortex-arkiv.vercel.app/console |
| **Source** | https://github.com/LingSiewWin/Cortex |
| **Chain** | [Arkiv Braga testnet](https://explorer.braga.hoodi.arkiv.network/) · chainId `60138453102` |

### For judges (start here)

| Doc | Purpose |
|-----|---------|
| **[docs/submission/SUBMISSION.md](./docs/submission/SUBMISSION.md)** | Theme, links, elevator pitch, entity types |
| **[docs/submission/JUDGES.md](./docs/submission/JUDGES.md)** | 5-minute code tour + repo map |
| **[docs/submission/pitch.md](./docs/submission/pitch.md)** | 3-minute demo script |
| **[docs/submission/JUDGE_DEFENSE.md](./docs/submission/JUDGE_DEFENSE.md)** | Q&A (ERC skips, market honesty, vs MemGPT) |

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

See **[scripts/README.md](./scripts/README.md)** for the full script list (demos & eval are optional).

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

High-level flows on Arkiv Braga — straight-line `sequenceDiagram`s (renders on GitHub or [mermaid.live](https://mermaid.live)).

### End-to-end

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

### Store a memory (browser wallet)

```mermaid
sequenceDiagram
  autonumber
  participant UI as Browser console
  participant API as store-file prepare
  participant OR as OpenRouter or Cohere
  participant Wallet as MetaMask on Braga
  participant Chain as Arkiv Braga

  UI->>API: file and optional caption
  API->>API: descriptor filename mime sha256
  API->>OR: embedText descriptor
  alt missing embedding API key
    OR-->>API: 401 embed error
    Note over Chain: Never reached no GLM spent
  else key present
    OR-->>API: 1536-d vector
    API-->>UI: prepared payload and RaBitQ metadata
    UI->>Wallet: sign key derivation
    UI->>UI: seal ciphertext wallet key
    Wallet->>Chain: mutateEntities on Braga
    Chain-->>UI: txHash entityKey 1h lease
  end
```

### Recall cite extend (Darwinian loop)

```mermaid
sequenceDiagram
  autonumber
  participant UI as Browser console
  participant API as citation manual API
  participant Loop as Session key loop
  participant Engine as recall and act
  participant Mirror as SQLite mirror
  participant Chain as Arkiv Braga
  participant SSE as SSE stream

  alt manual cite from console
    UI->>API: query string
    API->>Engine: runCiteCycle
  else autonomous loop
    Loop->>Engine: runCiteCycle
  end

  Engine->>Mirror: RaBitQ distance and attributes
  Engine->>Chain: query live entities
  Engine-->>SSE: recall.completed

  alt no hits
    Note over Chain: skip act nothing to extend
  else citations present
    Engine->>Chain: extendEntity remaining plus 24h
    Engine->>Chain: anchor decision MMR root
    Engine-->>Mirror: outbox and tier counters
    Engine-->>SSE: memory.cited and arkiv.rpc
  end
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

| Path | Contents |
|------|----------|
| `app/` | Next.js routes: `/`, `/console`, `/api/[[...path]]`, `/sse` |
| `lib/web/` | AppKit providers, connect gate, browser upload hook |
| `ui/` | Landing, console, MemoryGraph, upload UI |
| `src/lib/` | Arkiv client, crypto, sealing, Braga preflight |
| `src/compression/` | RaBitQ + embeddings + document payloads |
| `src/darwinian/` | extend, recall, citation, distill |
| `src/mirror/` | SQLite schema, replay, MMR, anchor, evict watcher |
| `src/topology/` | Graph builder for `/api/topology` |
| `src/api/` | HTTP handlers (auth, store-file, seed, …) |
| `src/agent/` | Autonomous loop, anchor worker |
| `src/mcp/` | MCP server for agent tooling |
| `src/obsidian/` | Vault → mirror sync |
| `cortex-plugin/` | Claude Code plugin (hooks, MCP, skills) |
| `scripts/` | seed, demo-flow, sovereignty-proof, plugin build |
| `tests/` | Offline + smoke/canary against Braga |
| `contracts/` | `CortexRegistry.sol`, `SynapticMarket.sol` |

---

## Claude Code plugin

Install from `cortex-plugin/` (after `bun run build:plugin`):

- **Hooks:** capture before compaction, recall at session start
- **MCP:** Cortex memory tools on stdio
- **Skill:** `cortex-memory` usage patterns

Config templates: `cortex-plugin/.mcp.json`, `hooks/hooks.json`.

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

---

## License

MIT — see [`LICENSE`](./LICENSE).
