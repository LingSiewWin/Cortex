# Cortex — Arkiv × ETHNS submission

| Field | Value |
|-------|--------|
| **Theme** | **AI + Privacy** (hybrid) — wallet-owned agent memory, client-side encryption, citation-driven expiration on Arkiv |
| **Project** | Cortex |
| **GitHub** | https://github.com/LingSiewWin/Cortex |
| **Live site** | https://cortex-arkiv.vercel.app |
| **Console** | https://cortex-arkiv.vercel.app/console |
| **Video** | https://www.loom.com/share/68178caad4034e8282ac412a440e0738 |
| **Chain** | Arkiv Braga · chainId `60138453102` |
| **`PROJECT_ATTRIBUTE`** | `{ key: "project", value: "cortex-ethns-2026" }` |

---

## Elevator pitch (form field, ~430 chars)

> Cortex is an AI that remembers like humans do. New thoughts stay short-lived; what you
> actually use in decisions sticks around and graduates from passing notes → lasting habits
> → distilled "rules you live by." The rest fades for free on Arkiv Braga. Memory is owned
> by your wallet, RaBitQ-compressed for real storage costs. MCP + Claude plugin so anyone
> can give their agent a digital twin—not amnesia every session. Live on Braga testnet.

---

## What to click first (2 minutes)

1. **Landing** — https://cortex-arkiv.vercel.app — product story + install strip for the Claude plugin  
2. **Console** — https://cortex-arkiv.vercel.app/console — connect wallet, watch SSE events, topology graph, manual recall/cite  
3. **Code entry** — `src/constants.ts` (`PROJECT_ATTRIBUTE`), `src/darwinian/extend.ts` (accumulative extend), `src/lib/arkiv-client.ts`  
4. **Tests** — `bun test` (offline + Braga smoke when env is set)  
5. **Braga proof** — [sovereignty round-trip tx](https://explorer.braga.hoodi.arkiv.network/tx/0x6c391af1fa9f9faa952b793980e2b657b33d724298b15a4b7e5fc174543828a2)

Full judge map: **[JUDGES.md](./JUDGES.md)** · judge script: **[pitch.md](./pitch.md)** · Q&A: **[JUDGE_DEFENSE.md](./JUDGE_DEFENSE.md)**

**Out of scope on Braga:** Synaptic Market escrow (`contracts/SynapticMarket.sol`) — Braga only admits Arkiv precompile txs, not general contract deploys. Darwinian memory + wallet encryption is the shipped product.

---

## Entity types on Arkiv (≥2 required)

| Type | Role | Typical expiration |
|------|------|-------------------|
| `observation` / `episode` / `rule` | Agent memory tiers (working → episodic → semantic) | 1 h → 7 d → 1 y cap |
| `citation` | Records each `act(..., citations[])` | Tied to parent memory |
| `state_root` | MMR anchor for decision provenance | Long-lived |

All stamped with `project=cortex-ethns-2026`; reads filter `$creator` (session key) + project attribute.

---

## Local run (judges who clone)

```bash
bun install && cp .env.example .env
# Fund SESSION_KEY via https://braga.hoodi.arkiv.network/faucet/
bun run faucet-check && bun run seed && bun run dev
# → http://localhost:3000/console
```

See [README.md](../../README.md) for full environment table.

---

## Video walkthrough outline (2–3 min)

See **[pitch.md](./pitch.md)** § “3-minute judge walkthrough” — problem → Darwinian extend → live console txs → wallet-owned encryption.
