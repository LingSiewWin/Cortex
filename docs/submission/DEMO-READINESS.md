# Cortex — Demo-Readiness Brief (Arkiv PM + Marketing pitch)

> Synthesized from a 4-expert adversarial audit that read the actual code
> (2026-06-11). Verdict: **GO / demo-safe.** Every claim below is code-backed.
> Do not say "permanent", "forever", "trustless", "fully decentralised", or
> "synchronous extend tx".

## Verified credibility assets (lead with these)

- **Measured gas receipt** — `lib/web/hooks/use-browser-upload.ts` reads the
  on-chain receipt (`gasUsed × effectiveGasPrice` via `waitForTransactionReceipt`);
  `ui/components/WalletUpload.tsx` renders "⛽ your wallet burned X GLM · N gas @ Y gwei".
  Independently verifiable against the block explorer with **zero Cortex code in
  the number**. This is the single most compelling 30 seconds.
- **Self-narrating decay receipt** — `cortex_act` returns a per-memory receipt and
  the MCP tool prints "+24h queued this cite; projected lease ~Nd (est.); tier
  observation (w=1.00→1.32, cites=2, outcome=…)". Tense-honest: "queued" not
  "extended", "(est.)" on the projection, **never a fabricated txHash** (the
  extend is optimistic — `outboxId` + later MMR anchor are the real handles).
- **Sovereignty (plugin path)** — payloads sealed client-side with a wallet-derived
  key; same wallet replays the local SQLite mirror. `scripts/sovereignty-proof.ts`.
- **Real Braga E2E this session** — create+read tx
  `0x2fc9c84d162a1a6a6aacb3b93beec98b66553067baddc5d77fee6f30525d401d`.

## The 90-second pitch script

1. **(0:00–0:20) The verifiable gas moment.** Console upload → MetaMask confirm →
   "⛽ your wallet burned 0.000000XX GLM" + explorer link. *"That gas is read
   straight from the on-chain receipt — no estimate, no Cortex code in that number."*
2. **(0:20–0:40) Memory should decay.** Show the `/decay` curve (Step 3). *"This
   memory starts with a 1-hour lease and decays; uncited memories evict for free
   via Arkiv's L1Block sync. I don't pay to forget."*
3. **(0:40–1:05) The Darwinian primitive.** `cortex_recall` → `cortex_act(citations)`
   in Claude Code → the receipt → the curve steps up. *"Citing a memory adds 24h —
   additive on Braga, verified on-chain. Committed locally, anchored asynchronously
   by a worker; the handle is the outbox id + MMR root, not a synchronous tx.
   Useful memories accumulate; useless ones decay."*
4. **(1:05–1:20) Sovereignty.** *"In the plugin every payload is sealed client-side
   with a wallet-derived key — a fresh machine re-derives it and replays the mirror.
   You own your memory even if my backend disappears. No key escrow."*
5. **(1:20–1:30) The ask — distribution, NOT blockspace.** *"Feature cortex-memory
   in the Arkiv marketplace/docs as the reference example of decay-aware sovereign
   memory, and co-write one 'why memory should decay' post. Arkiv gets the canonical
   developer-facing demo of additive extend + L1Block eviction."*

## Founder manual checklist (code can't do these)

1. **Fund the demo wallet** ([faucet](https://braga.hoodi.arkiv.network/faucet/)) —
   confirm non-zero GLM or Beat 1 dies on "insufficient funds". (Currently ~0.002 GLM.)
2. **Embedding key set** on the demo surface (OpenRouter/Cohere) — a 401 mid-upload kills Beat 1.
3. **Add `CORTEX_USER_SIGNATURE`** (`bun run derive-user-signature`) to demo the full sealed sovereignty loop.
4. **Don't narrate absolute block numbers** — the sync daemon doesn't run in the
   plugin-first product, so the chain cursor is 0/stale. The receipt curve's climb
   comes from committed-local state (citation_counts + outbox), which is honest.
5. **Rehearse "show me the extend tx"** → "act() is optimistic — the handle is the
   outbox id + the later MMR anchor; here's a real anchored extend from a prior run"
   (bookmark a real anchored tx and confirm it resolves before camera).

## Step 3 (the visual `/decay` timeline) — corrected build plan

Status: **not yet built** (`app/decay/`, `ui/components/DecayReceipt.tsx` absent).
Prerequisite (the latent baseline bug) is **already fixed** in `citation.ts`
(headBlock=0 → flagged estimate; clamped to a 1y sanity ceiling).

Drifts to honor:
- Routing is exact-string (`src/server/dispatch.ts` `ROUTES[path]`) — use a **query
  param**: `/api/decay/timeline?entityKey=…`. A `/api/decay` route already exists,
  so the timeline must be a **distinct** path.
- Deployed surface is **Next** (`app/api/[[...path]]/route.ts` → `dispatch.ts`);
  page at `app/decay/[entityKey]/page.tsx`. Mirror into `src/ui-server.ts` only for Bun demos.
- The on-chain upslope is **flat** for a freshly-cited memory (`extended` rows are
  written only by the daemon after anchoring). **Overlay committed-local state**
  (`citation_counts` + `listPendingOutbox`) for the climb and label it "queued /
  not yet anchored". Draw a **mandatory dashed synthetic downslope** ("projected
  neglect → eviction"). Render **durations** (`leaseSeconds`), not `projectedExpiresAtBlock`.

Files: `src/server/decay-timeline.ts` (handler) · register in `src/server/dispatch.ts`
· `ui/components/DecayReceipt.tsx` (inline-SVG, solid=on-chain / dashed=projected)
· `app/decay/[entityKey]/page.tsx`. Reuse `citation.ts` projection math + `utility.ts`
`leaseSeconds` — never recompute a parallel lease formula.
