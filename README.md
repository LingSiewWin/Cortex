# Cortex

**Darwinian memory for AI agents on Arkiv.** Memories that the agent cites in real decisions grow; ones that don't, decay for free.

Submission for the [Arkiv × ETHNS Builder Challenge](https://forms.arkiv.network/ethns-arkiv-challenge) — Theme: **AI** (Agents Whose Memory You Actually Own). Hybrid with **Privacy** (client-side encryption with deterministic user-derived keys).

> Status: **in development** — public-facing README will be finalised before the 2026-05-25 submission deadline. The text below is the judge-facing pitch.

---

## The pitch

Prior agent-memory products treat storage TTL as a *budget*. We treat it as a *fitness function*.

- Every observation is RaBitQ-compressed (1536-d float32 → ~672 bytes), stamped with the user's `$owner`, and written to Arkiv with a **1-hour starting expiration**.
- When the agent **cites** a memory inside an `act()` decision, Cortex fires `extendEntity` with **accumulative** reinforcement (`remaining + 24h`) — the memory's lease grows, it doesn't reset.
- Useless memories never get cited → Arkiv's L1Block sync evicts them for free.
- After ≥2 citations: working → episodic (+7 days). After ≥5 citations across ≥3 distinct sessions: an LLM distills the cluster into a plain-text **rule** entity with a 1-year lifespan.
- A local `bun:sqlite` daemon mirrors every Arkiv event so users own their data even if our backend disappears. The replay script is published via **ERC-5169 `scriptURI`** so anyone can self-host.
- Encryption keys are deterministically derived from the user's wallet — no central key escrow.
- **Synaptic Market**: distilled rules are written encrypted with public discoverability tags. Other agents pay a small GLM transfer to receive a one-time decryption grant.

## Why this is undefeatable on Arkiv specifically

Arkiv's `bytes × lifetime` pricing is the whole point of the protocol. Prior winners (`p2pmentor`, `ocean`, `brainpedia`) treated TTL as a storage budget — Cortex weaponizes it as a Darwinian selection mechanism. We're the first project to use `extendEntity` as a learned reinforcement signal grounded in LLM citation behaviour.

## Theme alignment

- **AI:** memory you own, decays with disuse, consolidates with utility. Hits the team's own framing: *"memory you own, portable across any tool that reads Arkiv."*
- **Privacy:** payloads encrypted client-side with keys deterministically derived from the user's wallet signature. Public attribute tags enable discovery without exposing payload contents.

## Architecture (high level)

```
agent observation → RaBitQ quantize (~672 B)
                  → encrypt with user-derived key
                  → mutateEntities batch (PROJECT_ATTRIBUTE + $creator=session, $owner=user)
                  → Arkiv precompile
                          ↓ emits ArkivEntityCreated
                  → bun:sqlite mirror daemon (durability + self-host via ERC-5169)

agent decision   → recall(query, k=5) → top-k memory ids
                  → act(action, citations=[ids]) → fires accumulative extend per cited id

nightly cron     → SQLite mirror → LLM distillation → semantic rule entity (1-year TTL)
                                                    → encrypt + publish to Synaptic Market
                                                    → buyer pays GLM → grant emitted → key released
```

## The 6 standards we ship

EIP-712 + ERC-5267 (session signatures), ERC-1271 + ERC-6492 (smart-wallet validation), ERC-4361 SIWE (human-readable login), ERC-5792 (`wallet_getCapabilities` runtime probe), ERC-5169 (`scriptURI` for the self-host replay script), ERC-8004 event-shape mimicry (forward compatibility, not a hard dependency).

**Explicitly skipped** (each for a concrete reason — see `docs/ERC.md`): ERC-7857 (no TEE oracle on Braga), ERC-6551 (smart-contract account can't speak brotli-RLP to the precompile), ERC-4337 (no bundler), ERC-7702 (Braga tx-type-4 unverified), ERC-2771 (precompile has no `_msgSender()`), ERC-7715 (no DelegationManager on Braga).

## Trust assumptions disclosed honestly

1. v1 runs a trusted relayer holding the `$creator` session-key EOA. Bounded by EIP-712 `SessionAuthorization` (`maxWrites`, `validBefore`, `entityNamespace`). v2 migrates to EIP-7702 when Braga supports it.
2. ERC-8004 events are emitted with the correct shape but Cortex does not implement reputation/validation flows — that's v2.
3. Local SQLite mirror is single-host in the demo. ERC-5169 `scriptURI` publishes the replay script so anyone can self-host with their own wallet derivation.
4. Semantic TTL capped at 1 year (not 5 / 250 years) as fee-model defense — Arkiv's fee model is unresolved per `docs/Arkiv.md` §3.1 Flaw 4.

## Setup

```bash
bun install
cp .env.example .env       # fill in SESSION_KEY_PRIVATE_KEY, USER_PRIMARY_ADDRESS, OPENAI_API_KEY
bun run faucet-check       # verify Braga balance
bun run smoke              # end-to-end create + read test against Braga
bun run mirror             # start the SQLite event daemon
bun run agent              # start the orchestrator
bun run dashboard          # ambient UI at http://localhost:3000
```

## Repo layout

```
src/
  constants.ts             # PROJECT_ATTRIBUTE + Braga + reinforcement params
  lib/                     # arkiv-client, eip712, ownership, session-key, crypto
  compression/             # rabitq + embedding pipeline
  mirror/                  # bun:sqlite event daemon + replay (scriptURI target)
  darwinian/               # recall, citation, extend (accumulative), distill
  market/                  # encrypted-listing publish + grant flow + seeded agents
  agent/                   # LLM orchestrator + tool definitions
contracts/                 # CortexRegistry (ERC-5169 + ERC-8004 events), SynapticMarket
ui/                        # Apple-Health-style dashboard
tests/
  canary-atblock.test.ts   # deliberately failing — demonstrates atBlock is broken on Braga
  smoke-create-read.test.ts
  reinforcement.test.ts
scripts/
  seed-demo-agents.ts
  faucet-check.ts
```

## License

MIT — see `LICENSE`.
