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

## License

MIT
