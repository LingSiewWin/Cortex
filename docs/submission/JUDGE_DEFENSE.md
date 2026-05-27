# Cortex — judge defense

Questions a judge or a careful reviewer is likely to ask, and the verbatim answer for each. No waffle.

---

### 0. "There's another vector-search-on-Arkiv project. How is Cortex different?"

Severyn's `arkiv-vector-search-poc` is excellent work — permissionless IVF semantic search over ~400k Wikipedia chunks, browser-native, TurboQuant-compressed. It validates that rotational quantization + Arkiv-as-substrate works. We cite it as complementary, not competitive, because we solve a different problem:

| | Arkiv Search (Severyn) | Cortex (us) |
|---|---|---|
| Problem | Static-corpus semantic search | Dynamic **agent memory** with a lifecycle |
| Data shape | Read-mostly, 400k fixed chunks | Read+write, per-user state that grows/decays |
| Arkiv used as | A KV store with `cell_id` attributes | A **verifiable, decay-aware state registry** |
| Lifespan | Permanent commitments | Accumulative `extend` — memories earn their life |
| Provenance | None | MMR roots **anchored on Arkiv** per decision |
| Theme | AI | **AI + Privacy hybrid** (encryption, hierarchical ownership, SIWE) |
| Economic layer | — | Synaptic Market (M2M memory exchange) |

The judge question that matters is "what does Arkiv enable that nothing else does?" His answer: cheap permissionless vector search. Ours: time-decaying agent memory with on-chain proofs of cited utility under ownership the user controls. Both are valid; they don't compete for the same win.

---

### 0b. "Why no IVF / ANN index like the other project?"

Different scale, different right answer. Severyn indexes 400k chunks — IVF (inverted-file with k-means cells + nprobe) is correct there; brute force would be too slow. Cortex's retrieval surface is **per-user agent state at the dozens-to-hundreds scale**. A linear scan over RaBitQ-compressed vectors (198 bytes each, unbiased inner-product estimator) stays well under 10ms at that cardinality. Adding IVF would mean centroid maintenance, cell-assignment churn on every write, and rebuild cost — for zero recall gain at our scale, and it would dilute the agent-memory pitch into "vector search with extras." We deliberately did not build it. If a single agent's working set ever exceeds ~10k live memories, IVF becomes worth revisiting (noted in `docs/Turboquant.md`).

---

### 1. "Why didn't you use ERC-7857 or ERC-6551?"

ERC-7857 (AI-NFT with encrypted metadata) requires a TEE oracle to mediate ownership transfers without leaking the encrypted payload. There is no TEE oracle deployed on Arkiv Braga today, so an ERC-7857 implementation here would be a stub that ships a `revert("oracle not deployed")` path and nothing else.

ERC-6551 (token-bound accounts) requires the account to be a smart contract that can call out via the EVM. The Arkiv registry is a Rust precompile at `0x...6172 6b 6976` that expects brotli-RLP-formatted transactions, not the standard EVM ABI shape a smart-contract account would emit. We confirmed this empirically — `docs/Arkiv.md` §1.1 documents the failure mode. ERC-6551 would compile and deploy, but the account would silently fail to write anything to Arkiv.

We chose the six standards that *work today* on Braga: EIP-712 + ERC-5267 + ERC-1271 + ERC-6492 + ERC-4361 (the signature surface, including counterfactual smart wallets), ERC-5792 (runtime capability probe), and ERC-5169 (`scriptURI` for the SQLite replay script). The full skip list with reasons is in the README under "The explicit DEAD list".

---

### 2. "Why is your relayer centralised?"

Because EIP-7702 (transaction type 4 — the EOA-to-smart-account upgrade that would let the user's primary EOA self-write) is not verified to function on Braga as of 2026-05. We tried it; the tx type is rejected upstream of the precompile.

The relayer's authority is bounded off-chain by the EIP-712 `SessionAuthorization` struct — `maxWrites`, `validBefore`, `validAfter`, `entityNamespace`, and a `bytes32 nonce`. The user signs once with their primary EOA; the relayer cannot exceed `maxWrites` writes, write past `validBefore`, or write outside the user's namespace. That's the same trust model Coinbase Smart Wallet, Privy, and others ship today.

When Braga verifies tx type 4, the signature stack stays — only the relayer drops out. The work is small because we built the typed-data flow correctly the first time.

---

### 3. "How does this differ from MemGPT, Letta, mem0, or Zep?"

Those projects manage **context windows** — what fits in the LLM's prompt at inference time. Their unit of work is "evict from prompt, page back in on retrieval". Storage is incidental.

Cortex manages **on-chain lifespan**. The unit of work is "extend this entity's expiration on a chain that prices bytes by lifetime". A memory in Cortex doesn't just leave the context window; it leaves chain state. It's reinforced by the agent's *behaviour* (citations in real decisions), not by a vector similarity score against a recent prompt.

The product is the eviction policy, not the recall layer. Vector recall on encrypted DBs is a commodity now. A learned, on-chain, citation-driven lifespan that costs the agent nothing for noise is the thing Cortex builds that nobody else has.

---

### 4. "What if Arkiv's fee model lands retroactively and you owe a year of GLM?"

Cap on every long-lived entity is 1 year. We do not write 5-year or 250-year leases — `REINFORCEMENT.semanticInitialSeconds = 365 × 24 × 60 × 60` in `src/constants.ts`. The 24-hour reinforcement increments multiply linearly with citations, so even a memory that gets cited every hour grows by a year per ~365 citations, which is at-most-once-per-day for a long-lived agent.

The math is intentionally conservative. If Arkiv's resolved fee model lands lower than we feared, we lift the cap by changing one constant and redeploying. If it lands higher, our exposure is bounded by the 1-year ceiling we already set.

This is documented as Trust Assumption #4 in the README, with the line to `docs/Arkiv.md` §3.1 Flaw 4.

---

### 5. "Is the Synaptic Market just a fake judge?"

**Honest answer: the market is a vision layer, not a working judge — and we don't claim otherwise (this reconciles with §12).** The escrow is **written but undeployable**: `contracts/SynapticMarket.sol` (`register`/`buy`/`Grant`) exists as source, but Braga **rejects all contract deployment** (it only accepts Arkiv-precompile txs — verified, see §12 + `docs/Arkiv.md`), so `register`/`buy` have **never run on-chain**.

What *is* real and tested: the listing publish path (`src/market/publish.ts`), the grant-watcher daemon (`src/market/decrypt-grant.ts` `startGrantWatcher`), and the wallet-derived AES-256-GCM seal/open (guarded by `market-publish.test.ts`). What's *not*: any end-to-end buy → pay → grant flow, because there's no contract to pay. (And v1 would leak the grant key world-readably without ECIES — a second reason it isn't shipped.)

So: the cryptographic + Arkiv-write building blocks are real; the *trustless market* on top of them is deferred until a chain that can host the escrow contract. The Arkiv-native, working product is the sovereign decay/reinforcement core — not the market.

---

### 6. "Why RaBitQ over TurboQuant?"

RaBitQ (Gao & Long, SIGMOD 2024) ships a closed-form unbiased estimator with a single alignment factor per code; TurboQuant's variance bound is tighter but requires storing a residual codebook and a per-query rotation. For 1536-dim OpenAI embeddings and v1's `k ≤ 20` recall window, RaBitQ's 1-bit code (198 bytes packed) is already 30× smaller than the raw 6144-byte float32 embedding, and the estimator's error is dominated by the embedding model's intrinsic noise — not by the quantization.

The TurboQuant brief is in `docs/Turboquant.md`. We will revisit it when the recall window opens past `k = 100` or when the agent's working set grows past ~10k live memories. At v1 scale, RaBitQ is the right wedge: smaller code, simpler code, one-file implementation.

The estimator's correctness — including the 1536/2048 truncation that looks suspicious but is actually unbiased — is documented inline in `src/compression/rabitq.ts` with the math worked out for a future auditor.

---

### 7. "What if I lose my session key?"

The session key is `$creator` on every working-tier memory — its loss revokes the agent's ability to write *new* memories but does not affect anything you already own. The moment a memory promotes to episodic, `changeOwnership` transfers `$owner` to your primary EOA (the wallet you signed in with). Your primary EOA can extend, update, or delete every episodic and semantic memory you own, regardless of whether the session key still exists.

Recovery: connect your primary wallet, sign a new SIWE login, and the dashboard issues a new EIP-712 `SessionAuthorization` to a fresh session key. Old working-tier memories that the dead session key created and never promoted will decay normally — which is biologically correct: an agent that never came back shouldn't keep its scratchpad alive.

Implementation in `src/lib/ownership.ts`. The "session-key dies → memory dies" failure mode is the exact problem that motivated the hierarchical-ownership decision; CLAUDE.md "Ownership model" section.

---

### 8. "What if your backend disappears?"

We don't argue this — we **prove** it. `bun run sovereignty-proof` does, on real Braga: seal+write a memory → `kill` the backend → **delete the entire local mirror** (clean machine) → cold-rebuild from the **public Arkiv RPC** with only the user's wallet → recall returns the memory; run it again **without** the wallet and the memory is present on-chain but unreadable (a recall miss, no crash). Proven 2026-05-23, tx `0x6c391af1fa9f9faa952b793980e2b657b33d724298b15a4b7e5fc174543828a2`.

What makes that real:
- **Encryption-at-rest.** Memories are sealed with AES-256-GCM under a key derived from your primary wallet (`src/lib/crypto.ts derivePayloadKey`, HKDF over `CORTEX_KEY_DERIVATION_v1`). The chain *and* the local mirror hold **ciphertext**; plaintext exists only in RAM during a recall (`src/darwinian/recall.ts` opens per-candidate). Same wallet → same key, deterministically. No escrow, no key vault to subpoena.
- **ERC-5169 `scriptURI`** points at `src/mirror/replay.ts` + the daemon hydrate path: anyone with chain access rebuilds owner/expiration/lifecycle from the Arkiv event log and re-fetches the (encrypted) payloads via `getEntity`.

The self-host flow is one wallet signature and one bun command. If our backend disappears tonight, you run your own Cortex tomorrow — and nobody without your wallet can read a single memory in the meantime.

---

### 9. "Can I transfer my memory to another wallet?"

Yes — `changeOwnership` is a first-class Arkiv operation. The current `$owner` (you, after a promotion) calls `wallet.changeOwnership({ entityKey, newOwner })` and `$owner` flips to the new address. `$creator` is immutable per Arkiv contract semantics, so the tamper-proof attribution of who *first wrote* the memory survives.

Bulk transfer is one batched `mutateEntities` call. The `promoteOwnership` helper in `src/lib/ownership.ts` is the same primitive — Cortex itself uses it on every tier promotion.

The one caveat: working-tier memories where `$creator = $owner = sessionKey` are owned by the relayer's ephemeral key. Transferring those requires the session to still be alive (the session key is `msg.sender`). Once you promote past working tier, `$owner` is your primary EOA and you can transfer them freely.

---

### 10. "Where does Cortex specifically use Arkiv's properties versus being chain-agnostic?"

Three load-bearing dependencies on Arkiv's specific design:

1. **`bytes × lifetime` pricing.** The whole reinforcement model is a no-op on a pay-once-store-forever chain like Arweave, and a budget-tracking nightmare on a per-operation chain like generic EVM. Cortex's `extend(remaining + 24h)` is meaningful *because* the chain's pricing rewards letting useless data evict. Without this, the citation-driven reinforcement loop has nothing to push against.

2. **Queryable attributes without an external indexer.** `cortexQuery().where(eq("entityType", "listing"))` runs directly against the Arkiv precompile and returns matching entities. The Synaptic Market's discovery flow — "find me all listings with confidence ≥ 80, ordered by price" — is one SDK call. On EVM L2 we would need The Graph or a custom indexer.

3. **Automatic L1Block eviction.** Uncited memories disappear from chain state for free via the OP-Stack L1Block predeploy sync — the system depositor at `0xdead...0001` calls `L1Block.setL1BlockValues` and any entity whose `expiresAtBlock` is now in the past disappears. Cortex never pays gas to sweep dead memories. On a generic EVM chain we would have to fund a sweeper bot.

What is chain-agnostic: the RaBitQ compressor, the EIP-712 signature stack, the SIWE flow, the dashboard, the encryption. Lift those to Ethereum L1 and they would work fine. Lift them, and you would lose all three of the properties above — which is the entire wedge.

---

### 11. "What's the actual thesis, and who's the closest competitor?"

The **Sovereign Memory Trilemma**: agent memory wants sovereignty (you own it; no operator can read/seize it), verifiability (a third party can trust a memory's provenance without trusting your machine), and performance/cost (hot-loop fast, near-zero marginal cost) — and naïve designs hold at most two. Local-only memory (the default in most agent frameworks) is sovereign+fast but **unverifiable** across a trust boundary. Centralized memory SaaS is fast+verifiable-via-provider but **not sovereign**. Naïve all-on-chain is verifiable but **slow and public**. Cortex doesn't beat the trilemma — it **routes** each memory to its corner: local-first hot path (fast+sovereign), selective MMR anchoring of RaBitQ-compressed embeddings (verifiable+cheap), wallet-derived client-side encryption (sovereign on a public ledger), and decay economics (bounded cost).

Closest competitor: **MemWal (Walrus + Sui), with Seal.** It's the only shipping decentralized agent-memory product with verifiable provenance, and it has primitives we don't (pay-to-decrypt, threshold key custody). Our defensible wedge it lacks: **decay-priced eviction + the citation→`extend` Darwinian primitive** — memory whose lease is a direct function of its proven utility. MemWal stores; Cortex *forgets economically*.

### 12. "Is this a real product or just a protocol judge?"

Cortex exposes an **OpenClaw-compatible adapter interface** (`memory-arkiv`) for **OpenClaw**'s single active memory slot (`memory_store` → sealed Arkiv write, `memory_recall` → decay-aware recall), aiming to turn a local-only assistant's memory into a portable, verifiable, cross-device backend. **Honest scope (do not overclaim):** the adapter's tool surface is validated against Braga via `bun run openclaw-harness` (store tx `0xf3c20dd8607a67e6e40c932d94752935cb3662a43a07881a3e5c272c067c765b`; recalled #1), but it has **not been run inside a live OpenClaw gateway** — `openclaw`/`typebox` aren't installed here, and the harness exercises the adapter functions directly, not the full plugin contract. It is a spec-compliant adapter awaiting gateway integration, not a "proven drop-in plugin."

The on-chain *memory market* (agents trading provenance-proven memories) is the further product vision, and we **deferred it for a concrete, empirically-verified reason — not hand-waving.** We tested whether Braga can host the escrow contract it would need (ERC-8183-style, or our `contracts/SynapticMarket.sol`): it **cannot**. Braga's public RPC only admits transactions to the Arkiv precompile — every general EVM tx, including a plain transfer and any contract creation, is rejected with `-32602 "Missing or invalid parameters"` (`scripts/braga-tx-diagnostic.ts`; the Solidity `EntityRegistry` is "future design," not deployed — see `docs/Arkiv.md`). So **Arkiv-as-deployed monetizes *persistence* (precompile btl/rent), not *commerce***. A real market needs a separate general-EVM chain with Arkiv as the data substrate, or Arkiv shipping its Solidity layer. That's the precise upstream ask — and it's why the sovereign-decay core (which *is* Arkiv-native, and proven) is the product today, with the market as a composed expansion.

### 13. "Do you have a NUMBER proving the utility weighting actually helps recall — or is it just a nice story?"

Yes, measured offline on a **real corpus** (`bun scripts/eval/recall-ablation.ts`). The corpus is 23 query→answer topics extracted *verbatim* from our own `/docs` (chain params, the ERC stack, RaBitQ, tier promotion, etc.), embedded with the **real** provider (OpenRouter `text-embedding-3-small`, 1536-d), quantized to RaBitQ 1-bit (198 B) — i.e. the exact production retrieval regime. Each query has **hard same-topic distractors** (sibling doc passages sharing vocabulary).

**Headline (5 seeds × 23 queries):** fusing the SEDM weight lifts **nDCG@5 by +25.4%** (0.573 → 0.719), recall@3 **+40%**, recall@5 **+27.5%**; **11 wins / 12 ties / 0 losses**, paired bootstrap **95% CI [+0.067, +0.234]** — excludes zero, so the lift is significant on this corpus.

The honesty safeguards (so this isn't a rigged judge):
- **The test is hard.** Mean gold−best-distractor similarity gap **Δ = −0.0162** — gold is, on average, *less* similar than its top distractor, so pure embedding similarity genuinely can't separate them. That's the regime where a usage signal earns its keep.
- **No oracle / no leakage.** "True usefulness" (gold-ness) is **hidden** from the weight mechanism; the weight evolves only from a **noisy, sparse proxy** (simulated citation outcomes corrupted by Gaussian noise + a distractor false-positive rate) run through the *real* `proxyUtility`/`evolveWeight` pipeline. The proof it's not an oracle: the lift **decays monotonically** as the proxy gets noisier (+0.170 at σ=0 → +0.110 at σ=2.0).
- **RaBitQ cost shown, not hidden.** Same script reports 1-bit vs full-precision: recall@1 identical (43.5%), recall@5 73.9% → 69.6%.

**What actually drives the lift (we ran the strict test, and we disclose the result):** a frequency-control sweep raises the distractor citation rate `pDist` toward the gold rate `pGold=0.6`, so gold and distractors are cited *equally often* and the only remaining signal is the (noisy) outcome. The lift **collapses monotonically to exactly zero**:

| pDist | nDCG@5 lift |
|---|---|
| 0.20 (gold cited 3× more) | **+0.1455** |
| 0.30 | +0.0526 |
| 0.45 | +0.0034 |
| 0.60 (equal frequency) | **+0.0000** |

So the honest claim is precise: **Cortex's recall lift comes from citation *frequency* — memories the agent uses more get ranked higher — which is exactly the Darwinian thesis (utility = usage).** It is NOT the stronger claim that the weight discriminates "genuine usefulness" beyond how often a memory is used; at equal usage, the current tuning adds ~0. We could raise `sigOutcome` to chase an outcome-only lift, but that would be tuning-to-win the eval (a methodology sin), so we report the mechanism as it is.

**Other caveats stated plainly:** n=23 is a small corpus and the usage history is *simulated* (no live deployment log yet), so this proves the *mechanism*, not a production number. The 0-losses reflects that on this corpus gold uniformly accrues more citations than its distractors. Live-usage validation lands once Braga's RPC stabilizes and the loop accrues real citations.

---

## V2 Protocol Hardening — where we know we're brittle (and own it)

A self-audit surfaced real architectural debt. We're documenting it rather than faking it — knowing exactly where you're brittle is the honest founder move.

- **Sovereignty depends on the Arkiv RPC (C1).** "Survives operator death" means *our* operator — recovery still re-fetches entities from a single hosted Arkiv RPC (`getEntity` per entity). No multi-RPC fallback or self-run-node path yet. Honest claim: "no *Cortex*-operator dependency; needs any Arkiv RPC/node." V2: multi-endpoint + archival fallback, shown recovery of a large corpus against an RPC we don't control.
- **Single master key, no rotation (C2).** One wallet signature → HKDF → one AES key → all memories, forever. The signature lives in `CORTEX_USER_SIGNATURE` (env), and the derivation message lacks a nonce/origin/expiry so it's replayable/phishable. V2: bind the message to a nonce + origin + version; treat it as rotatable root key material; per-epoch subkeys.
- **Spend-guard is in-RAM (M5).** The cap resets on restart and tracks *estimated* gas. It's a speed bump, not a hard cap — the real control is the on-chain SessionAuthorization budget (which V2 must actually enforce, not just sign).
- **Now mitigated — off-chain scoring (was #0/M1).** Previously tier + weight lived only in local SQLite, so the chain couldn't prove evolution. **Fixed:** the per-act CITATION payload now carries the post-act `{tier, weight, count}` (`src/darwinian/citation.ts`), committed to the anchored MMR root; `score-replay.ts` reconstructs the scoring from the on-chain citation log alone and verifies inclusion against the root. Delete the SQLite — the evolutionary history is replayable + provable from chain.

### Optimistic Memory Buffering — PROVEN LIVE (2026-05-25)

`act()` no longer blocks on Braga: it commits scoring to the local mirror + enqueues a durable outbox bundle, and a single retrying worker drains it on-chain. Proven end-to-end on live Braga (all tx `status 0x1`, blocks 830137–830159): create → **extend** ([reinforce tx](https://explorer.braga.hoodi.arkiv.network/tx/0x6e05ad1237720720c1c4e56978d1337b2b8f900de530bf8268194eb61be39834)) → **citation entity** `0x585581c9…` ([cite tx](https://explorer.braga.hoodi.arkiv.network/tx/0x7a7be42a83b37fb3e61350bd5cb6c4db0f7d6c31a207ca5d266a0fdc16b3e5de)) → **state-root anchor** `0x2dbc6a41…` ([anchor tx](https://explorer.braga.hoodi.arkiv.network/tx/0x4a9ccf321e06f5db89c90c2c759ca14bd1f7b55de74c1eb3dcd4dfb838b5f5a4)) → both cited memories reconciled `verified=1`. Repro: `bun scripts/eval/live-anchor-proof.ts`.

**The decoupling earned its keep on the first try:** the chain was mid-recovery with an inconsistent RPC pool (heights spanning 37k blocks), so the first drain failed read-after-write — and the buffer **retained the bundle and lost nothing**; it anchored cleanly once the pool converged (the script's preflight waits for that).

### Optimistic Memory Buffering — debt found in adversarial review (2026-05-25) and where it stands

A design + code + test review of the new optimistic-buffering path surfaced these; the load-bearing ones are fixed, the rest are scoped honestly:

- **Fixed — MMR double-append.** The anchor worker appends the citation leaf, and the daemon later re-observes the same on-chain CITATION entity and would append it again → a divergent root. `appendToStateMMR` is now **idempotent** (dedup by leaf hash, `src/mirror/state.ts`), so worker + daemon + a bundle retry all land the leaf once. Tested (`tests/anchor-worker-hardening.test.ts`).
- **Fixed — non-atomic reconcile.** `markOutboxSent` + `markVerified` now run in one `db.transaction`, closing the crash window that could leave a bundle `sent` but its memories stuck `verified=0`.
- **Fixed — unbounded retry / head-of-line blocking.** A permanently-failing bundle now dead-letters to `status='failed'` after `MAX_ATTEMPTS=8` (`markOutboxDead`), so one poison bundle can't block the queue forever or burn gas re-broadcasting a reverting tx. Tested.
- **Bounded, not eliminated — double-extend on retry.** A bundle that fails *after* its `extend` lands re-extends on retry (accumulative, so the lease over-grows). The dead-letter cap bounds this to ≤8×; the real fix (a per-step journal so completed steps are skipped on retry) is V2. Over-extending a genuinely-cited memory is directionally benign (it earned the lease), so this is low-severity.
- **Known — `_lastRecallIds` is process-global.** Concurrent agent loops share one last-recall set, so interleaved `recall→recall→act` could validate citations against the wrong set. Single-agent v1 is unaffected; V2 returns a per-recall token that `act()` consumes.
- **Known — recall doesn't re-check decay vs wall-clock during a chain stall.** When Braga freezes, expiry GC freezes too, so `recall` can surface a memory whose lease lapsed during the freeze. V2: compare `expiresAtBlock` against the mirror's own clock and tag stale results (the investigation's hardening rec #4).
- **Known — MMR rebuild ordering.** Live append order (worker FIFO at drain) and cold-restart rebuild order (`entities.payload_hash` by ingest rowid) can differ for a citation leaf. The dedup makes counts consistent; deterministic *position* across rebuilds is a V2 item (a persisted leaf-ordinal). Inclusion-by-membership still holds; positional proofs may need a rebuild.

## Bonus: questions we don't expect but have answers for

### "Why no vector DB?"

Per `docs/Pass-Winning.md` (lessons from prior winners), the `brainpedia` submission found that Arkiv attributes plus LLM-context stuffing outperformed a separate vector DB for their workload — and we're storing 1536-dim embeddings packed to 198 bytes, which fits inside the entity's payload directly. Adding a vector DB would be a second source of truth, a second sync problem, and a second thing for the user to host. The candidate window is `CANDIDATE_LIMIT = 50` pulled by attribute filter, then scored in-memory. That's fine up to ~10k live memories.

### "Why no KV-cache compression?"

`docs/Idea.md` Pillar 1 documents the fix: KV-cache compression is an LLM-runtime concern, not an on-chain primitive. The chain stores *embeddings*, not raw KV state. Compressing embeddings is exactly what RaBitQ does. Compressing KV state and putting it on-chain would be incoherent — the cache shape is tied to the model architecture and would be useless to a different model.

### "Why two entity types instead of one big JSON blob?"

Six entity types — `observation`, `episode`, `rule`, `citation`, `listing`, `grant`. Each has its own lifespan policy and ownership model, and Arkiv attribute queries make it cheap to filter by type. Stuffing everything into one schema would break the "filter by entityType, then by createdBy" trust pattern from `arkiv-best-practices` §11–12.

### "Why is the canary test failing on CI?"

It's *supposed* to fail. Read `tests/canary-atblock.test.ts`. The header documents the asymmetric assertion. If it ever starts passing, we win — that means Arkiv shipped the historical-query fix.
