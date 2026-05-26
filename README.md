# Cortex

> **Darwinian memory for AI agents** — thoughts that earn the right to survive,
> with a cryptographic proof they happened. Sovereign by construction.
> _(AI + Privacy hybrid · Arkiv × ETHNS Builder Challenge)_

## What it does

Every agent observation is RaBitQ-compressed (1536-d → 198 bytes, ~31×) and
written to Arkiv with a one-hour starting expiration. When the agent **cites**
a memory in a decision, Cortex extends its lifespan via accumulative `extend`.
Useful memories grow toward years; useless ones expire for free via Arkiv's
L1Block sync. Every decision also appends to a Merkle Mountain Range whose root
is **anchored on Arkiv**, so any verifier can prove a memory was in the agent's
history.

Two tools, period: `recall(query, k)` and `act(action, citations[])`.

### The live spine

`/console` isn't a static dashboard reading a database. An autonomous agent
runs in the server process and cites memories every ~20s; every Arkiv RPC call,
every RaBitQ encode, every MMR append, and every state-root anchor publishes a
typed event onto an SSE stream that the dashboard renders in real time. Load
the page and watch the chain work — query → recall → reinforce → anchor — with
live Braga tx links, or type your own query to drive a cycle manually.

## Sovereign by construction

Memories are **encrypted at rest with a key derived from your wallet** — the chain
*and* the local mirror hold ciphertext; plaintext exists only in RAM during a
recall, gated by your wallet's signature (`derivePayloadKey` → AES-256-GCM, no key
escrow). This resolves the **Sovereign Memory Trilemma** (sovereignty ↔
verifiability ↔ performance/cost) by routing each memory to its corner: a
local-first hot path for speed, selective MMR anchoring for verifiability, and
wallet-encryption for sovereignty on a public ledger.

The headline consequence — **memory survives the operator dying:**

```bash
bun scripts/sovereignty-proof.ts   # kill backend → wipe the entire mirror → rebuild
                                   # from the PUBLIC Arkiv RPC with ONLY your wallet →
                                   # recall survives & decrypts; without it, unreadable
```

Proven on Braga (2026-05-23): seal+write → wipe mirror → cold-rebuild → recall HIT
with the wallet, MISS without it —
[tx](https://explorer.braga.hoodi.arkiv.network/tx/0x6c391af1fa9f9faa952b793980e2b657b33d724298b15a4b7e5fc174543828a2).

### OpenClaw-compatible adapter ([OpenClaw](https://github.com/openclaw/openclaw))

Cortex exposes an **OpenClaw-compatible adapter interface** (`extensions/memory-arkiv/`)
for OpenClaw's single active memory slot: `memory_store` → sealed write to Arkiv,
`memory_recall` → decay-aware recall. The aim is to turn a local-only assistant's
memory into a portable, verifiable, cross-device backend. **Honest status:** the
adapter's tool surface is validated against Braga via `bun scripts/openclaw-harness.ts`
([store tx](https://explorer.braga.hoodi.arkiv.network/tx/0xf3c20dd8607a67e6e40c932d94752935cb3662a43a07881a3e5c272c067c765b)),
but it has **not yet been run inside a live OpenClaw gateway** — the plugin shell is
spec-compliant and awaiting that integration.

## Quick start

```bash
bun install
cp .env.example .env       # SESSION_KEY_PRIVATE_KEY, USER_PRIMARY_ADDRESS,
                           # + CORTEX_USER_SIGNATURE or CORTEX_USER_PRIVATE_KEY (sealing)

bun run faucet-check       # pre-flight on Braga
bun run seed               # seed demo memories the agent will cite
bun run dashboard          # http://localhost:3000/console — watch the cascade
bun run spine-check        # one-process proof: real Braga ops → live events
bun run demo-flow          # scripted end-to-end demo
bun scripts/sealed-e2e.ts          # encryption-at-rest round-trip (key vs no-key)
bun scripts/sovereignty-proof.ts   # operator-death survival proof
```

> Seed **before** starting the dashboard: the autonomous loop and the seed
> script share one session-key EOA, so running them concurrently collides on
> tx nonces.

## Stack

- Runtime: Bun + TypeScript
- Network: Arkiv Braga testnet (chainId `60138453102`)
- Compression: RaBitQ 1-bit quantizer @ 1536-d
- Identity: EIP-712 session keys + SIWE
- Mirror: `bun:sqlite`, replayable via ERC-5169 `scriptURI`

## Repo map (where to look when something breaks)

| Path | What lives here |
|---|---|
| `src/lib/` | Arkiv client, crypto, identity (SIWE/EIP-712/session keys). Start here if a write fails. |
| `src/compression/` | RaBitQ quantizer + embedding pipeline. Start here if recall returns nonsense. |
| `src/darwinian/` | `extend` (accumulative reinforcement), `recall`, `citation`, `distill`. |
| `src/mirror/` | Local `bun:sqlite` shadow + MMR + anchor + replay daemon. |
| `src/market/` | Synaptic Market — publish, grant decrypt, seeded buyer/seller/amnesic agents. |
| `src/api/`, `src/ui-server.ts`, `ui/` | Dashboard backend + React frontend. |
| `contracts/` | `CortexRegistry.sol` (ERC-5169 `scriptURI`), `SynapticMarket.sol` (escrow). |
| `scripts/` | `faucet-check`, `demo-flow`, `backfill`, `mmr-bench`. |
| `tests/` | Offline suite + `canary-atblock` (deliberately failing) + `smoke` (real Braga tx). |

## Troubleshooting

| Symptom | What it means |
|---|---|
| `embedText: OPENAI_API_KEY is not set` | Add it to `.env` or swap providers in `src/compression/embeddings.ts`. |
| Faucet rejects "enter valid eth address" | You pasted the **private** key. Derive the address: `bun -e "import('viem/accounts').then(m => console.log(m.privateKeyToAccount(process.env.SESSION_KEY_PRIVATE_KEY).address))"` |
| `extend reverted: newBtl <= currentBtl` | The accumulative-extend math is being bypassed. See `src/darwinian/extend.ts` — `newBtl = remaining + reinforcement` must be strictly greater. |
| Smoke test hangs on write | Balance is 0. Run `bun run faucet-check`, then top up the session-key address at the faucet. |
| Canary **passes** (instead of failing) | Arkiv shipped the `atBlock` fix. Drop the SQLite cold-tier path. |
| Explorer link 404s for a fresh tx | Braga RPC lag — wait a block (~2s) and retry. |

Useful links:

- Explorer: https://explorer.braga.hoodi.arkiv.network/
- Faucet:   https://braga.hoodi.arkiv.network/faucet/
- RPC:      `https://braga.hoodi.arkiv.network/rpc`

## Security notes (read before a public deploy)

The dashboard's write/control endpoints (`/api/citation/manual`, `/api/loop/control`)
are **unauthenticated** for a frictionless local demo. They are gated by a
process-scoped spend guard (`src/agent/spend-guard.ts`): a session cap +
per-IP rate limit, shared by the autonomous loop and the manual path. The SSE
endpoint caps concurrent connections (global + per-IP). Queries are clamped and
control-stripped before being embedded / broadcast / written on-chain.

For a **public deployment** (e.g. a judge URL), additionally:
- Gate the write/control endpoints behind the existing SIWE viewer-session
  cookie (the 6-ERC identity stack is already built — reuse `cortex_session`).
- Fund the session key with a **minimal float** (e.g. 0.05 GLM) and never
  auto-refill from a hot faucet — the spend cap resets on process restart.

The autonomous loop runs server-side, so the ambient cascade demo works without
any auth; only interactive writes need it.

## License

MIT
