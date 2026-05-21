# Cortex

> A Darwinian memory engine for AI agents on Arkiv.

Built for the **Arkiv × ETHNS Builder Challenge**.

## What it does

Every agent observation is RaBitQ-compressed and written to Arkiv with a
one-hour starting expiration. When the agent **cites** a memory in a
decision, Cortex extends its lifespan. Useful memories grow, useless ones
expire for free.

Two tools, period: `recall(query, k)` and `act(action, citations[])`.

## Quick start

```bash
bun install
cp .env.example .env       # fill SESSION_KEY_PRIVATE_KEY, USER_PRIMARY_ADDRESS

bun run faucet-check       # pre-flight on Braga
bun run smoke              # one-shot write + read
bun run dashboard          # http://localhost:3000
bun run demo-flow          # scripted end-to-end demo
```

## Stack

- Runtime: Bun + TypeScript
- Network: Arkiv Braga testnet (chainId `60138453102`)
- Compression: RaBitQ 1-bit quantizer @ 1536-d
- Identity: EIP-712 session keys + SIWE
- Mirror: `bun:sqlite`, replayable via ERC-5169 `scriptURI`

## Configuration

| Env var | Required | What it does |
|---|---|---|
| `SESSION_KEY_PRIVATE_KEY` | yes | 32-byte hex. Ephemeral session-key EOA — all writes route through it. |
| `USER_PRIMARY_ADDRESS`    | yes | Your primary EOA. Becomes `$owner` on tier promotion. |
| `OPENAI_API_KEY`          | live recall only | Embedding provider — see `src/compression/embeddings.ts` to swap. |
| `ANTHROPIC_API_KEY`       | distillation only | LLM that distills episodic memories into semantic rules. |
| `ARKIV_RPC_HTTP`          | optional | Override default `https://braga.hoodi.arkiv.network/rpc`. |
| `ARKIV_RPC_WS`            | optional | Override default `wss://braga.hoodi.arkiv.network/rpc/ws`. |

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

## License

MIT
