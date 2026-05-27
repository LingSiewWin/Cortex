# Cortex — live judge script

## The 30-second version (no CLI — just open the page)

This is the headline. It needs no terminal narration; the dashboard performs itself.

**Pre-flight (once):**
```bash
bun run faucet-check     # confirm the session key is funded
bun run seed             # seed 8 memories the agent will cite
bun run dashboard        # then open http://localhost:3000/console
```

**On camera — open `/console` and say nothing for 20 seconds.** An autonomous
agent runs inside the server and cites a memory every ~20s. Within one tick the
judge watches, live and unprompted:

1. The **hero widget** lights its phase track: Recalling → Deciding → Reinforcing → Anchored, with the current query ("How does MMR proof verification work in Cortex?").
2. The **Arkiv RPC ticker** streams real calls — `mutateEntities 178B 6.8s`, `extendEntity 32B`, `getEntity` — each with a clickable Braga tx link. *This is the chain working in real time, not a mirror read.*
3. The **RaBitQ tile** ticks: `1536d → 198B · 31× · 0.4ms`. Compression, proven per query.
4. A **memory constellation** dot flares orange and grows as it's cited; over time it migrates from the WORKING zone toward EPISODIC.
5. The **MMR panel** appends a leaf (`leaves: 101`), and the **anchor pill** in the topbar flashes a new root with a tx link — a cryptographic commitment per decision.
6. The **agent budget** ticks down with a live runway estimate.

Then say one line: *"Nothing here is staged — every tx link goes to Braga. Type your own query and the agent runs it live."* Type a query, hit **Cite**, and the same cascade fires on demand.

That is the differentiation against static vector-search tools: Cortex's surface renders its substance, live, on real chain state.

> Verified end-to-end on Braga 2026-05-22 — the autonomous loop produced
> citation + extend + state-root-anchor txs visible in `/console` (see
> `docs/specs/2026-05-22-cortex-live-spine-plan.md` for tx hashes).

---

## The full 2:45 CLI walkthrough

Total runtime: **2:45**. Spoken at conversational pace. Every on-screen element below corresponds to something you can point at in the running app.

## Pre-flight (off-camera)

Three terminals open:
- `T1` — `bun run mirror` (event daemon, idle until things happen)
- `T2` — `bun run dashboard` (Bun.serve at `http://localhost:3000`, browser pre-loaded)
- `T3` — empty prompt, ready for `bun run cite-flow`

Browser shows the dashboard with one or two pre-seeded memories so the room isn't empty on frame one. Explorer tab open at `https://explorer.braga.hoodi.arkiv.network/` ready to receive the tx hash from `cite-flow`.

---

## Script

`[00:00]` — **Open on the dashboard.**
Voice: "Most agent-memory products treat storage lifespan as a budget. Cortex treats it as a fitness function."
Show: the three tier cards — **Working / Episodic / Semantic** — with their decay bars. Point at a working-tier memory whose bar is two-thirds drained.

`[00:12]` — **Zoom into one working memory.**
Voice: "Every agent observation is RaBitQ-compressed, stamped with the user's owner, and written to Arkiv with a one-hour starting expiration. That bar you're watching decay is the entity's actual lifespan on Braga right now."
Show: hover the memory card — tooltip shows `expiresAtBlock`, `remainingSeconds`, the `creator` (session key) and `owner` (user EOA).

`[00:25]` — **Switch to T3, run the walkthrough.**
Voice: "When the agent actually cites a memory in a decision, the lifespan grows. Let me show you."
Type: `bun run cite-flow` and press enter.

`[00:30]` — **Watch the terminal.**
Show: `[1/4] Creating 3 observation entities…` rolls past. Three entity keys appear with explorer links. Highlight that the bot just packed three 1536-dim embeddings into ~198 bytes each and batched them into one transaction.

`[00:45]` — **The recall.**
Show: `[2/4] Recalling memories about rug-pull risk…` rolls past with three candidate keys + their inner-product scores.
Voice: "The agent has exactly two tools — recall and act. Recall returns candidates ranked by RaBitQ-estimated similarity. Anything not in this list cannot be cited."

`[01:00]` — **The act.**
Show: `[3/4] Firing act() — accumulative extend on the top 2 cited memories…`
Voice: "Citations are validated against the recall set. A hallucinated ID gets dropped silently — it does not bump tier counts, it does not trigger spurious extends."
Show: the two `act tx` hashes appearing with explorer links.

`[01:18]` — **Cut back to the dashboard.**
Show: the two cited memories' decay bars have grown — visibly longer than they were 60 seconds ago, while the uncited third memory's bar continued to drain.
Voice: "That's accumulative extend in action. The new expiration is `remaining + 24 hours`, not a reset to 24 hours. Naïve extend reverts the moment remaining exceeds the reinforcement window — Arkiv's extend is REPLACE-not-ADD. The fix is in `src/darwinian/extend.ts`."

`[01:35]` — **Open the Synaptic Market panel.**
Show: a `listing` row with `ruleTag: anti-rug`, `confidence: 92`, price displayed in GLM, encrypted payload size.
Voice: "After five citations across three distinct sessions, an LLM distills the memory cluster into a plain-text rule. The rule is sealed with a fresh per-listing key, written to Arkiv with public discovery tags, and registered on a minimal escrow contract."

`[01:50]` — **Trigger the seeded buyer.**
Click: "Trigger judge buy" button (or wait for the buyer-agent's 30-second tick).
Show: a `buy(listingKey)` transaction lands on Braga. A few seconds later, a `Grant` event fires, and the seller's grant-watcher publishes a grant entity. The market panel's `sales` count ticks up; the buyer's row now shows the decrypted plaintext rule.
Voice: "The buyer pays GLM. The contract emits Grant. The seller's relayer answers off-chain by writing a grant entity carrying the decryption key, tagged with the buyer's address."

`[02:10]` — **Open the test output.**
Show: terminal scrolled to `bun run canary` output: `✅ Canary confirms: atBlock is still silently ignored on Braga…`
Voice: "We ship a test that's deliberately asymmetric. It asserts the broken behaviour of Arkiv's atBlock historical query — empirically verified on Braga 2026-05. If the protocol ever ships the fix, this test flips and we get a notification. We're building against the chain that actually exists, not the one in the spec."

`[02:25]` — **The self-host pitch.**
Open: `contracts/CortexRegistry.sol` and scroll to `scriptURI`.
Voice: "If our backend disappears tomorrow, the registry's ERC-5169 scriptURI points to the SQLite-mirror replay script. Anyone with chain access can rebuild their Cortex from chain events alone. Encryption keys are deterministically derived from their wallet signature — no central escrow."

`[02:40]` — **Close.**
Cut back to the dashboard, working tier visibly thinned, episodic and semantic populated.
Voice: "Memory you own. Decays with disuse. Consolidates with utility. Built on the only chain that prices bytes by lifetime — Arkiv."

`[02:45]` — **End frame.**
Show: GitHub repo URL + `forms.arkiv.network/ethns-arkiv-challenge`.

---

## Backup beats (if a beat falls flat)

| If… | Recover by… |
|---|---|
| `cite-flow` fails on the recall step (no `OPENAI_API_KEY`) | The script falls back to a deterministic synthetic vector — the walkthrough still completes; mention it explicitly: "Embeddings are seeded for the offline judge; the production path uses text-embedding-3-large." |
| Braga RPC stalls mid-act | Show the SQLite mirror — `select * from entities order by last_event_block desc limit 5;` — point at the rows that are already there. "The mirror is the source of truth in the read path; the dashboard never depends on Braga being responsive." |
| The buyer-agent's 30s tick is too slow | Trigger it manually with the dashboard button, or paste a `buyAndDecrypt(...)` snippet into `bun -e` directly. |
| A judge asks "how is this different from MemGPT/Letta?" | Point at the canary test message + the architecture diagram. "MemGPT manages context windows. Cortex manages on-chain lifespan. The product is the *eviction policy*, not the recall layer." |

---

## What NOT to say

- Don't say "permanent" — Arkiv entities expire by design.
- Don't say "trustless" or "fully decentralised" — we run a relayer in v1.
- Don't say "TTL" in front of the camera — use "expiration" or "lifespan", per the Arkiv team's own framing.
- Don't claim the Synaptic Market is sealed to the buyer's pubkey yet — it isn't in v1.
- Don't oversell the agent runtime — Cortex ships `recall` + `act` tools and the engine behind them. The LLM orchestrator that drives those tools is the *consumer*, not part of the submission.
