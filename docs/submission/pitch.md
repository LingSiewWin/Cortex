# Cortex — Pitch & Judge Walkthrough

> **Voice:** Web3 DevRel — honest that Braga is young; show working code, not roadmap slides.
> No "trustless forever" fluff.
>
> **Ground truth:** [README.md](../../README.md), [Arkiv.md](../Arkiv.md), [COMPETITORS.md](../COMPETITORS.md)  
> **Live:** [cortex-arkiv.vercel.app/console](https://cortex-arkiv.vercel.app/console)
>
> **Record on:** `/console` (**Judge** mode). **`?dev=1`** = engineer cockpit + memory inspector only.

### Jump to

| Section | Use when |
|---------|----------|
| [Scene-by-scene director's guide](#scene-by-scene-directors-guide-super-candid) | **Recording today** — every click + line |
| [First principles](#first-principles--what-we-store-and-why-no-jargon) | You forgot why this exists |
| [3-minute script (short)](#3-minute-judge--click-by-click--script) | Teleprompter condensed |
| [Mean-girl audit](#mean-girl-audit-know-our-gaps) | What we're weak at |
| [B-roll Scene 10](#scene-10--b-roll-only-3045s--prove-retrieval) | Prove text comes back |

---

## "What did you build?" — elevator pitch (under 500 chars)

> Cortex is Darwinian memory for AI agents on Arkiv Braga: agents only recall and act;
> every citation extends on-chain lease time; useless memories decay for free. Payloads
> are wallet-encrypted; decisions are MMR-anchored. RaBitQ compresses embeddings ~31×.
> Plugin + `bun run mcp` for Claude/Cursor. Live on Braga testnet.

**~380 characters** — paste into the submission form as-is.

---

## One sentence (open the video with this)

> **Cortex is memory for AI agents on Arkiv: agents search and cite memories; cited
> ones stay longer on-chain; useless ones expire — all locked to your wallet.**

---

## First principles — what we store and why (no jargon)

### The problem

Chat agents **forget** when the session ends. A vector DB in someone else's cloud is not
**yours**, and storing everything forever is wasteful.

### What we store

**Records on Arkiv** — each is a **memory** with an **expiry date** and **your wallet** as owner.
The real content is **text the agent can read later** (or a short **pointer** for images).

| What you put in | What's on Arkiv | What "retrieve" means |
|-----------------|-----------------|------------------------|
| **README / Obsidian note** | **Full note text** (encrypted) | Search or inspector → **same words back** |
| **PNG / binary** | **Not the file** — filename + hash + caption | Agent finds "that upload"; **you keep the file on disk** |
| **Agent scratchpad** | Tiny **fingerprint** (~198 B) of a fact | Search only — **not** a readable note |

### Tx hash ≠ memory

- **Tx hash** (`Stored on Arkiv · 0x…`) = **receipt** that Braga accepted a write.
- **Memory** = the **decrypted text** (inspector, recall, or Claude plugin).

If you only see a hash, you stopped at the receipt — **open inspector or recall the document.**

### What's the point?

1. **Remember** across Claude Code sessions (plugin + MCP).
2. **You own it** (wallet + local mirror), not our Postgres.
3. **Unused memories expire** (free cleanup on Arkiv).
4. **Used memories live longer** (cite in `act()` → extend lease).

**Not:** Dropbox, photo backup, Wikipedia search (that's Severyn's lane).

### Real product vs console booth

| | What it is |
|---|------------|
| **Product** | Obsidian vault sync + **Claude Code plugin** + `recall` / `act` / `cortex_store_document` |
| **Console (Judge)** | **Proof booth** — graph, wallet upload, automated cite judge for judges |
| **Autonomous agent strip** | **Server judge robot** (canned questions every ~20s) — **not** Claude thinking in your IDE |

---

## What you're holding on Arkiv (items)

| Item (entity type) | Plain name | Holds |
|--------------------|------------|--------|
| **document** | Your upload / note | Full text + search embedding |
| **document** (image upload) | Picture index | `[cortex-upload]` + sha256 + caption |
| **observation** | Agent fingerprint | ~198 B compressed meaning |
| **episode / rule** | Promoted memories | Longer-lived agent knowledge |
| **citation** | One decision | Which memories were cited in one `act()` |

**Only two agent tools:** `recall(query)` → IDs + text previews · `act(action, citations)` → extend cited memories.

---

## Judge screen map (Judge mode only)

```
┌─────────────────────────────────────────┐
│  Graph + HUD (Memories / RaBitQ)        │  ← SHOW ~40s
├─────────────────────────────────────────┤
│  Upload: file → cost → MetaMask → tx    │  ← SHOW ~70s  ★ MAIN PROOF
├─────────────────────────────────────────┤
│  Autonomous agent strip (cite judge)     │  ← SHOW ~30s
│  Install strip                          │  ← SKIP (voice only)
└─────────────────────────────────────────┘
```

| Section | 3 min video? | Proves |
|---------|--------------|--------|
| Memory graph | Yes | Memories exist; brightness ≈ time left |
| Upload + cost + sign | Yes | Wallet-owned write; cost before MetaMask |
| Stored on Arkiv · 0x… | Yes | Real Braga tx → explorer |
| Autonomous agent / Last recall | Yes (brief) | recall → cite → extend |
| Install strip | Skip | Real path: plugin + `bun run mcp` |
| Developer / playgrounds / RPC ticker | **Never** | Engineer junk |

---

## Scene-by-scene director's guide (super candid)

Read this like a shot list. **Main video = Judge mode only.**  
**B-roll = Scene 10 (dev inspector)** — paste after main edit or show to judges live.

### Before you press record (off camera)

| # | Do | Candid why |
|---|-----|------------|
| P1 | Open `/console` — confirm header shows **JUDGE** toggle (not Developer) | Developer mode will make you panic-scroll |
| P2 | Connect wallet `0xD350…` (or yours) on **Braga** | Wrong chain = MetaMask 0 GLM drama |
| P3 | Check green **Braga gas** line shows ~0.004+ GLM | If 0, faucet first |
| P4 | File on desktop: **`README.md`** from your repo | Real file > lorem ipsum |
| P5 | Tab 2: [Braga explorer](https://explorer.braga.hoodi.arkiv.network/) | You'll cmd-click the tx |
| P6 | (Optional) Terminal: `bun run dev` + seeded mirror so graph isn't empty | Empty graph on frame 1 looks dead |
| P7 | Close Discord, notifications, hide bookmarks bar | Screen recording hygiene |
| P8 | Browser zoom **100–110%** — graph + upload readable | Judges on phones |

**Do NOT open before record:** `?dev=1`, playgrounds, GitHub in same window (tab switch later).

---

### Scene 1 — Cold open on the graph (0:00–0:25)

| | |
|---|---|
| **URL** | `…/console` (Judge) |
| **Scroll position** | Top — **memory graph** fills ~70% of viewport |
| **Mouse** | Still. Optional: slow hover over a **bright** node (don't click yet) |
| **Camera sees** | Dots/lines, HUD: Memories / RaBitQ / Agent budget, legend at bottom |

**Say (verbatim OK):**  
"Hi — this is Cortex. AI agents forget everything when the chat ends. We store **memories**
on Arkiv Braga — Ethereum testnet with **expiry dates**. Each dot is one memory. **Brighter**
means more time left. We're not building Dropbox — we're building **memory that expires unless
the agent actually uses it.**"

**Do NOT:**  
- Click **Developer** in header  
- Scroll down to upload yet  
- Read the long paragraph above the file picker out loud  
- Say "trustless" or "forever"

**If graph is empty:**  
Say: "Graph fills when you store or when the mirror syncs — I'll add one in ten seconds."
Then continue to Scene 2 without apologizing for five minutes.

---

### Scene 2 — Scroll to upload (0:25–0:35)

| | |
|---|---|
| **Scroll** | Smooth scroll until you see **Choose file** and **Cost before you sign** box |
| **Mouse** | Don't click file yet — **point** at the cost box (even if it still says "Choose a file…") |

**Say:**  
"Under the hood I'll upload a real README from our repo. You always see **cost and lease
before** MetaMask opens — no surprise gas."

**Candid:** Ignore **Repository or link**, **Caption**, and the **Braga gas** essay unless
a judge asks. They're useful IRL; they're boring on video.

---

### Scene 3 — Pick file + wait for estimate (0:35–0:55)

| | |
|---|---|
| **Click 1** | **Choose file** |
| **Click 2** | Select **`README.md`** (show filename in picker if OS allows) |
| **Wait** | Until **Cost before you sign** populates — usually a few seconds |
| **Mouse** | **Stop moving.** Let judges read |

**On screen they should see (approximate):**

- Source file: ~few KB–MB  
- On-chain sealed: ~few KB (not the full 200KB if it were an image)  
- Initial lease: ~1 year  
- Network fee: `<0.0001 GLM`  
- Total estimate: `<0.0001 GLM`

**Say:**  
"This is a **text note** — the full markdown will be stored encrypted. If this were a PNG,
only a **hash and caption** would go on-chain — not the image bytes. That's intentional."

**Pause 2 full seconds** on the cost panel. Silence is fine.

**If estimate errors:**  
Read the red error. Common: missing `OPENROUTER_API_KEY` / `COHERE_API_KEY` on server.
Don't fake it — say "embed key missing on this deploy" and use pre-recorded b-roll OR local
`bun run dev`.

**Do NOT:**  
- Click **Preview link cost**  
- Fill **Caption**  
- Click **Store** before estimate loads  

---

### Scene 4 — MetaMask sign (0:55–1:20)

| | |
|---|---|
| **Click** | **Store on Arkiv · &lt;0.0001 GLM** (or whatever button shows) |
| **MetaMask** | Popup — confirm **Network: Braga**, **not** Ethereum mainnet |
| **Click** | Confirm / Approve |
| **Wait** | Until green success on console |

**Say (while MM open):**  
"**My wallet** signs the write. GLM on Braga is the native gas token — it's not in your
ERC-20 token list. You need the Braga network selected."

**If MetaMask says insufficient GLM:**  
Stop. Faucet. Don't wing it on camera — judges remember failures.

**When success line appears:**  
`Stored on Arkiv · 0x9edc… · graph refreshes in a few seconds`

**Say:**  
"That's the **receipt**. The memory is the note text — not this hex string. I'll show
retrieval in a second clip via the inspector; for now watch the graph update."

**Candid truth:** Judge mode doesn't open inspector yet — that's why we have Scene 10 b-roll.
Don't pretend the hash *is* the memory.

---

### Scene 5 — Explorer proof (1:20–1:35)

| | |
|---|---|
| **Click** | **Cmd+click** (Mac) or **Ctrl+click** (Win) the **tx link** in the green line |
| **Tab** | Braga explorer — tx detail page |
| **Mouse** | Scroll once to show it's a real transaction |

**Say:**  
"Real Braga transaction — hackathon judges can paste this hash. Project attribute
`cortex-ethns-2026`."

**Click back** to console tab.

**Do NOT:**  
- Stay on explorer more than ~15 seconds  
- Try to decode payload hex on explorer (it's encrypted — looks like noise)  

---

### Scene 6 — Graph refresh (1:35–1:55)

| | |
|---|---|
| **Scroll** | Back to **top** — graph |
| **Wait** | 3–5 seconds — optional new node / brighter cluster |
| **Mouse** | Hover the area where new upload might appear |

**Say:**  
"That upload is now part of the memory graph — same pool the agent searches when it
**recalls**."

**If nothing changes visually:**  
Say: "Mirror refreshes every few seconds — the write is already on Braga from the tx."
Don't debug on camera.

**Do NOT:**  
- Point at **Memories: 0** in dev mode — in Judge mode, hero HUD may still show counts  
- Open Developer mode  

---

### Scene 7 — Autonomous agent strip (1:55–2:25)

| | |
|---|---|
| **Scroll** | Until **Autonomous agent** / compact agent row is visible |
| **Read** | Label: `live` or paused · **Last recall:** `Why does accumulative extend…` (or similar) |
| **Wait** | Up to 20s for phase to change: Recalling → … → **Cited** or **Anchored** |

**Say:**  
"This strip is a **robot judge** on our server — **not** Claude Code reading my repo. Every
~20 seconds it runs the same two steps we give real agents: **search memories**, then
**cite** one in a decision. Cited memories **extend** their lease on Arkiv. Uncited ones
**expire**. That's the whole product thesis."

**If you see `Cited 0xfe42… · lease +24h`:**  
Point at it. "That memory just got more life because something cited it."

**If you see `Anchored` + tx link:**  
"Decision log anchored on-chain — bonus proof."

**If strip is idle / paused:**  
Say: "On Vercel the background loop may be off — locally `bun run dev` runs this continuously.
The rule is the same in the Claude plugin."  
**Do not** click Pause unless it was accidentally paused.

**Do NOT explain:**  
- "Last recall" as if Claude asked your project that question  
- Install strip commands below  

---

### Scene 8 — Real product path (2:25–2:45) — voice only

| | |
|---|---|
| **Scroll** | Optional: hold on graph OR slight scroll showing upload success still visible |
| **Mouse** | Still |

**Say:**  
"The real product is **Claude Code + our plugin**. Your Obsidian vault or repo notes sync
to Arkiv. Before a decision the agent **recalls** — searches these memories. After, it
**acts** and must list which memory IDs it actually used — no fake citations. Useful
memories accumulate lease time; useless ones decay. Install via marketplace **`LingSiewWin/Cortex`**
→ `cortex-memory` → `cortex auth`; or `bun run mcp` from a clone — not a fake npm package."

**Do NOT:**  
- Scroll to **Live install path** / `plugin install` unless you have 5 seconds and want one flash  
- Say `npx @cortex-network/mcp-server`  

---

### Scene 9 — Close (2:45–3:00)

| | |
|---|---|
| **Screen** | Graph + your face (optional) OR full-screen console |
| **Mouse** | Still |

**Say:**  
"Cortex — **wallet-owned** agent memory on Arkiv that **earns its lease** when cited.
Console and GitHub in the submission. Happy to show full note text in the inspector or walk
through the plugin after. Thanks."

**End card (edit):**  
Console URL · GitHub · one explorer tx link

---

### Scene 10 — B-roll ONLY (30–45s) — prove retrieval

**Not in the same 3 min timeline** — record separately, cut in or show live to judges.

| | |
|---|---|
| **URL** | `/console?dev=1` |
| **Click 1** | Toggle **Developer** (or open `?dev=1`) |
| **Click 2** | Upload README again OR use entity key from Scene 4 if you copied it |
| **Click 3** | **Open in inspector →** on success line (dev upload has this button) |
| **Read** | Modal: `type: document` · **memory:** full README markdown |

**Say:**  
"People ask: 'I only see a tx hash.' Hash is the receipt. **This** is the memory — full
text, decrypted with my wallet. Images would show hash and caption only, not pixels."

**If inspector shows observation / RaBitQ:**  
Wrong entity — you opened a seed memory, not your upload. Close, open the key from **your**
upload tx in explorer → entity key → paste in dev inspector via graph node if needed.

---

## Disaster recovery (super candid)

| What went wrong | What to do on camera |
|-----------------|----------------------|
| MetaMask 0 GLM | "Need Braga network + faucet" — cut, don't ramble |
| Estimate 500 / embed error | Switch to local `bun run dev` or use yesterday's tx + Scene 10 |
| Graph never updates | Show explorer tx only — "graph catches up from mirror" |
| Agent strip idle | Say Vercel workers off — cite rule still true in plugin |
| You opened Developer by mistake | "Engineer view" — **stop**, re-record Judge take |
| Judge asks "where's my PNG" | "Index only — by design — notes are full text" |
| Judge asks "is that Claude?" | "No — server judge loop; Claude uses plugin" |

---

## Two-take recording order (recommended)

| Take | What | Length |
|------|------|--------|
| **A** | Scenes 1–9 Judge mode | ~3:00 |
| **B** | Scene 10 dev inspector | ~0:30 |
| **Edit** | A + cut B after Scene 5 or 9 | ~3:20 total |

---

## 3-minute judge — click-by-click + script

| Time | Beat |
|------|------|
| 0:00 | Hook + graph |
| 0:25 | README upload + cost + sign + explorer |
| 1:35 | Graph + cite strip |
| 2:15 | Product path (voice) |
| 2:50 | Close |

**Do not scroll to:** Developer mode, Recall playground, Proof playground, Decision timeline,
Trilemma, evicted list, Developer Hub.

---

### [0:00 — Hook + graph]

**Click:** None — graph fills frame. Point at **Memories** / node brightness.

**Say:**  
"Agents forget when the chat ends. Cortex puts memories on Arkiv Braga — each dot is a
memory. Brighter means more time left before expiry. Only useful memories should survive."

---

### [0:25 — Upload README] ★ hero

**Click:**

1. **Choose file** → `README.md`
2. Wait for **Cost before you sign** — pause **2 seconds**
3. **Store on Arkiv** → MetaMask on **Braga** → approve
4. Stop on **Stored on Arkiv · 0x…**

**Say:**  
"Full README text is sealed on-chain, encrypted with my wallet. I see cost and lease
**before** I sign. The tx hash is the receipt — the memory is the text inside."

**Click:** Cmd+click tx → [Braga explorer](https://explorer.braga.hoodi.arkiv.network/).

**Say:**  
"Real write on Braga — not mocked."

**Skip:** Repo link field, caption (unless 15s spare).

---

### [1:35 — Graph + cite strip]

**Click:** Scroll up; wait for graph to update.

**Click:** Point at **Autonomous agent** bottom strip.

**Say:**  
"This is a **live cite judge** on the server — not Claude in my IDE. It searches memories,
cites one, and **extends its life** on Arkiv. Uncited memories expire. Same rule as the
plugin: **recall**, then **act** with real citation IDs."

**If `Last recall: Why does accumulative extend…`** — that's a **canned judge question** from
the rotation pool, not your repo.

**If Cited / Anchored flashes** — "That memory just earned more lease time."

**Prep:** `bun run cite-flow` or local `bun run dev` + seed so the strip isn't idle.

---

### [2:15 — Product path] *(voice, no scroll)*

**Say:**  
"Real usage: notes from Obsidian or your repo sync to Arkiv. Install the Cortex plugin in
Claude Code — `/plugin marketplace add LingSiewWin/Cortex`, `/plugin install cortex-memory`,
`cortex auth` — then **recall** before you decide, **act** with the memories you used. No npm
package; fallback is `bun run mcp` from a clone. This console proves one note on Braga."

---

### [2:50 — Close]

**Say:**  
"Cortex — wallet-owned agent memory that earns its lease. Console and GitHub in the
submission. I can show full text recovery in the inspector or via the plugin after."

---

## B-roll (30s) — prove retrieval (recommended)

Record **after** the 3 min take on **`/console?dev=1`**:

1. Upload `README.md` (or use existing entity key from success line)
2. Click **Open in inspector →** (dev upload path)
3. Scroll **`memory`** field — show **full markdown**

**Say:**  
"The hash was the receipt. **This** is the memory — full text, wallet-decrypted."

---

## Technical walkthrough (if judges ask "how it works")

```
Note upload
  → embed meaning (API key on server)
  → encrypt with key from wallet signature
  → write "document" entity on Arkiv (~1 year lease for uploads)
  → SQLite mirror copies events (your backup)

Claude (plugin): "anything about auth?"
  → recall: search mirror, return text + memory IDs

Claude: "we use JWT" + cites IDs from last recall
  → act: extend lease on each cited memory on Arkiv
  → optional: anchor decision in Merkle log

Unused memories → expiry → dropped on Arkiv (no forever storage)
```

| Piece | Plain English |
|-------|----------------|
| **Arkiv / Braga** | Chain DB where every record has an **expiration** |
| **Wallet** | You own records; encryption from your signature |
| **Mirror** | Local SQLite copy — fast search, survives if we shut down |
| **RaBitQ** | Shrinks agent **fingerprints** to ~198 B (cost) — **not** your README |
| **MMR anchor** | Tamper-evident log of decisions — bonus proof, not the main pitch |
| **Obsidian sync** | `bun run obsidian-sync` — vault → full notes on Arkiv (separate from console) |

**Honest Braga caveats (integrity):**

- `extend` is **REPLACE** — we use `remaining + reinforcement` so it never reverts (`src/darwinian/extend.ts`).
- Historical `atBlock` queries broken — cold tier = mirror replay, not time travel (`docs/Arkiv.md`).
- Vercel may not run background agent — full loop on local `bun run dev`.

---

## Mean-girl audit (know our gaps)

### Critical — fix, disclaim, or b-roll

| Issue | Truth | On video |
|-------|-------|----------|
| Only see tx hash | Hash = receipt; text in **document** | B-roll: dev inspector with full README |
| Judge mode no inspector | Upload stops at hash | Say "text in plugin/recall"; show dev b-roll |
| `npx @cortex-network/mcp-server` | **Not on npm** | Marketplace: `/plugin marketplace add LingSiewWin/Cortex` → `/plugin install cortex-memory` → `cortex auth`; fallback **`bun run mcp`** from clone |
| Autonomous agent = Claude? | Server robot, canned queries | Say **"live cite judge"** |
| "Download my PNG back" | Only hash + caption | One sentence: images are index only |

### Messy — don't show

| Issue | Action |
|-------|--------|
| Dev mode cockpit | Stay on **Judge** for main video |
| Live Memories = 0, graph has dots | Don't point at "0" — owner filter quirk |
| Playgrounds / RPC ticker | Cut |

### Strong — lean in

| Strength | Show |
|----------|------|
| Cost before sign | Pause on estimate panel |
| Wallet upload + explorer | README + tx click |
| Cite → extend | Agent strip pulse |
| Document = full text | Dev inspector b-roll |
| AI + Privacy + behaviour | Voice: not just CRUD memory |

**30s honest pivot (optional energy):**  
"If you only look at the green tx line, it feels like a receipt printer. The memory is the
decrypted note. The strip is a robot judge, not Claude. What we're selling is
**use-it-or-lose-it memory on Arkiv** with a Claude plugin — and we prove one README on
Braga today."

---

## Pre-judge checklist

| Step | Action |
|------|--------|
| URL | `/console` — toggle **JUDGE**, not Developer |
| Wallet | Braga `60138453102`, GLM from [faucet](https://braga.hoodi.arkiv.network/faucet/) |
| File | `README.md` (≤2MB) |
| Explorer | Tab open |
| Embed key | `OPENROUTER_API_KEY` or `COHERE_API_KEY` in server `.env` |
| Adopt | Connect wallet → sign adoption once |
| Cite pulse | `bun run cite-flow` or local `bun run dev` + `bun run seed` |

```bash
bun run faucet-check
bun run seed
bun run dev    # http://localhost:3000/console — best for live cite strip
```

**Vercel:** Upload + graph OK; autonomous loop may be idle unless `CORTEX_START_WORKERS=1`.

---

## Do not claim on stage

| Don't say | Why |
|-----------|-----|
| "Download any file from Arkiv" | Images = hash + caption; **.md** = full text |
| `npx @cortex-network/mcp-server` | Marketplace **`cortex-memory`** plugin + `cortex auth`, or **`bun run mcp`** from clone |
| Autonomous strip = Claude | It's a **server cite judge** |
| Autonomous loop always on Vercel | Say **local dev** for full loop |
| Permanent / forever storage | *Expiration*, *lease*, *decay* |
| "Trustless" / "fully decentralized" | Per Arkiv challenge guidance |

---

## UI glossary (if asked)

| UI | What it is |
|----|------------|
| **Memory graph** | Related memories; brightness = lease remaining |
| **Cost before you sign** | Sealed size × lease + Braga gas estimate |
| **RaBitQ HUD** | Compression of **search vectors**, not your PNG |
| **Agent budget** | GLM left for **session-key judge agent** in `.env` |
| **Last recall** | Latest canned question in the **judge loop** |
| **Install strip** | `/plugin marketplace add LingSiewWin/Cortex` → `/plugin install cortex-memory` → `cortex auth`; fallback `bun run mcp` from clone |

---

## Claims to have ready

| Claim | Source |
|-------|--------|
| `~31×`, `1536d → 198B` | RaBitQ tile · `src/compression/rabitq.ts` |
| Accumulative extend | `src/darwinian/extend.ts` |
| Citation-gated `act()` | `src/darwinian/citation.ts` |
| `project=cortex-ethns-2026` | `src/constants.ts` |
| Example tx | Your latest upload from console success line |

---

## Differentiation (one line each)

| Them | Cortex |
|------|--------|
| Continuum / mnemos | Importance TTL → **cite to grow** |
| ark-hive / Exo | Chat log → **`recall` + `act` only** |
| Fhedin | Pay to extend → **extend when agent cites** |
| Severyn | Static search → **per-agent memory lifecycle** |

Full scan: [COMPETITORS.md](../COMPETITORS.md).

---

## Cheat sheet (print)

| Moment | Click | Say |
|--------|-------|-----|
| Open | `/console` Judge | "Memory for agents on Arkiv" |
| Proof | README → cost → sign → tx | "Full note, wallet-encrypted" |
| Receipt | Explorer | "Real Braga write" |
| Darwin | Agent strip | "Cite extends life — judge loop" |
| Retrieve | Dev b-roll: inspector | "Hash ≠ memory; this is the text" |
| Product | Voice | "Obsidian + Claude plugin" |
| Never | npx, "download PNG", dev playgrounds | — |

---

## Optional 90-second cut

Graph (15s) → README upload + cost + explorer (40s) → cite pulse (15s) →
cite-to-survive (10s) → GitHub (10s).

---

## Reference links

| | URL |
|---|-----|
| Deploy | https://cortex-arkiv.vercel.app |
| Console (judge) | https://cortex-arkiv.vercel.app/console |
| Console (inspector) | https://cortex-arkiv.vercel.app/console?dev=1 |
| Source | https://github.com/LingSiewWin/Cortex |
| Explorer | https://explorer.braga.hoodi.arkiv.network/ |
| Faucet | https://braga.hoodi.arkiv.network/faucet/ |
| RPC | `https://braga.hoodi.arkiv.network/rpc` |
| Chain ID | `60138453102` |



## Part 3 — 3-minute script (problem → Cortex → judge → close)

**Arc:** sovereignty problem → AI×Web3 trilemma → what Cortex is → **prove on console** → powerful close.  
**Record on:** `/console` (Judge mode). Keep moving — problem is voice; proof is clicks.

### The trilemma (say once, ~10s — don’t lecture)

| Corner | Centralized AI today | Cortex on Arkiv |
|--------|----------------------|-----------------|
| **Sovereignty** | Vendor-hosted; you co-own the session, not the bytes | Wallet-owned, client-encrypted payloads |
| **Memory** | Session ends → context gone; or dump everything forever | Cite → extend; ignore → decay |
| **Cost / speed** | Big embeddings × forever storage = expensive noise | RaBitQ ~31× smaller fingerprints; pay lease only for what survives |

---

### [0:00–0:35] Problem + why Cortex (graph on screen)

**Click:** Open `/console`. Graph fills frame. Point at memory dots / brightness HUD.

**Say:**

“Right now, most agent memory is centralized. Your Claude Code session, your reasoning trail, your notes in someone else’s cloud — you don’t fully own them. You co-own them with the platform. And we all know what happens when privacy is an afterthought.

In AI × Web3 people talk about a trilemma: **sovereignty**, **memory**, and **cost**. Pick two. Store everything forever and you bleed money. Keep it cheap in a vendor DB and you don’t own it. Put it on-chain raw and it’s slow and expensive.

I built **Cortex** — an AI memory layer on Arkiv that pushes on all three. Wallet-owned. Memories that behave like human memory: what you cite stays, what you ignore fades. And **RaBitQ** compresses embeddings about thirty-one times so Braga stays practical.

This console is the proof booth. Each dot is a memory — brighter means more expiration left.”

---

### [0:35–1:30] Upload README ★ hero (sovereignty + cost on screen)

**Click:**

1. Scroll to **Choose file**
2. Pick **README.md**
3. Pause **2 sec** on **Cost before you sign**
4. **Store on Arkiv** → MetaMask → **Approve**
5. Stop on green: **Stored on Arkiv · 0x…**

**Say:**

“This is sovereignty you can see. I upload a real README. Before MetaMask I see **size and cost** — that’s the cost corner of the trilemma, upfront. The full note is sealed with **my wallet**, written to Braga. Not a row in our Postgres. This hash is the receipt; the memory is the text inside.”

**Click:** Top right → **Developer** (`/console?dev=1`). Right pane → **Integrate Cortex** (MCP tab visible). Pause on terminal block.

**Say:**

“Same engine you just watched — drop sovereign, decay-aware memory into your stack. **Integrate Cortex**: Claude Code marketplace **`LingSiewWin/Cortex`** → `/plugin install cortex-memory` → `cortex auth`; or `bun run mcp` from a repo clone for Cursor and other MCP clients. **OpenClaw** tab too. Tools: `cortex_recall`, `cortex_act`, `cortex_store_document`.”

---

### [1:30–2:10] Playgrounds (compress · recall · prove)

**Click:** Left pane — scroll to **RaBitQ Encoder** → paste a short sentence → **Encode** (show ratio).  
**Click:** **Recall Playground** → type a query → **Recall** (show hits).  
**Click:** **Proof playground** → paste entity key from upload tx / inspector → **Fetch proof** (show path).

**Say:**

“**RaBitQ Encoder** — paste text, see compression — that’s how Braga stays practical. **Recall Playground** — query the live store, same ranking the agent uses. **Proof playground** — paste an entity key, **Fetch proof** — MMR inclusion verified in the browser. Compress, recall, prove — that’s why these panels ship on the site.”

---

### [2:10–2:40] Product path (voice — tie trilemma back)

**Click:** None (optional: flash trilemma scoreboard if visible).

**Say:**

“Day to day: Obsidian or your vault syncs to Arkiv; install the Cortex plugin in Claude Code. Before a decision, **recall**. After, **act** with the IDs you actually used — that triggers extend. **RaBitQ** keeps embeddings small; **decay** keeps the bill honest. Sovereignty, memory, and cost — not pick two.”

---

### [2:40–3:00] Close (powerful, land the submission)

**Click:** Hold on graph or green **Stored on Arkiv** — your face optional, 2 seconds max.

**Say:**

“Agents shouldn’t rent their past from a platform that can reset it tomorrow. **Cortex** is wallet-owned memory on Arkiv: cite it or lose it, encrypt it yourself, compress it with RaBitQ, prove it on Braga today. Console and repo are in the submission — open it, upload a file, watch something expire and something survive. That’s the trilemma, solved in one layer. Thank you.”

