# Cortex — guide for judges & reviewers

One repo, one product. This is **not** a monorepo release train — it is a single application with a web UI, core engine, Claude plugin, and optional VS Code extension. Use this page so you do not have to grep the tree.

**Start here:** [SUBMISSION.md](./SUBMISSION.md) (links + elevator pitch) → live [console](https://cortex-arkiv.vercel.app/console) → this map.

---

## 5-minute code tour

| Order | Path | Why it matters (rubric) |
|-------|------|-------------------------|
| 1 | `src/constants.ts` | `PROJECT_ATTRIBUTE`, tier thresholds, Braga RPC |
| 2 | `src/lib/arkiv-client.ts` | create / query / extend against Braga |
| 3 | `src/darwinian/extend.ts` | Accumulative extend (additive precompile: `expiresAt += reinforcement`, verified on-chain) |
| 4 | `src/darwinian/recall.ts` + `src/compression/rabitq.ts` | Hybrid recall, RaBitQ — no vector DB |
| 5 | `src/lib/crypto.ts` + `src/lib/payload-key.ts` | Wallet-derived AES-GCM (Privacy theme) |
| 6 | `src/mirror/db.ts` + `src/mirror/schema.sql` | SQLite mirror, replay, user-owned copy |
| 7 | `app/console/page.tsx` + `ui/console.tsx` | Live dashboard, SSE, wallet upload |
| 8 | `cortex-plugin/` | MCP + hooks — portable agent memory |
| 9 | `tests/smoke-create-read.test.ts` | Real Braga create + read when env set |

Deep Braga findings (precompile, extend semantics, broken `atBlock`): **[../Arkiv.md](../Arkiv.md)**  
Likely questions (ERC skips, market honesty, vs MemGPT): **[JUDGE_DEFENSE.md](./JUDGE_DEFENSE.md)**

---

## Top-level layout (what is what)

```
Cortex/
├── app/              Next.js routes (/, /console, /api, /sse)
├── ui/               React landing + console + MemoryGraph
├── lib/web/          Wallet (Reown AppKit), browser Braga upload
├── src/              Core engine (Arkiv, Darwinian, mirror, MCP)
├── cortex-plugin/    Claude Code plugin (ship dist/ for install)
├── extensions/       Optional OpenClaw memory extension (secondary)
├── assets/           Landing media (copied to public/ at build)
├── scripts/          CLI: seed, smoke, sovereignty-proof, plugin build
├── tests/            bun:test — offline + Braga smoke/canary
├── contracts/        Solidity (registry + market — Braga deploy limited)
└── docs/submission/  Form-ready summary + judge tour (this folder)
```

**Intentionally not in git** (local only): `.env`, `cortex-mirror.sqlite`, `CLAUDE.md`, `.cursor/`, bulk research under `docs/archive/` (if present locally).

**Vercel note:** Default deploy skips persistent SQLite workers; landing + wallet upload + `/api/health` work. Full mirror/loop needs local `bun run dev` or a long-running host.

---

## Scripts — which ones matter for review

| Script | Use |
|--------|-----|
| `bun run dev` | Full stack locally (recommended) |
| `bun test` | CI-grade suite |
| `bun run smoke` | One real Braga write + read |
| `bun run seed` | Seed judge memories (before autonomous loop) |
| `bun scripts/sovereignty-proof.ts` | End-to-end encrypted round-trip proof |

Other `bun run *-judge` / `scripts/eval/` entries are **development & ablation** — not required to score the submission.

---

## Arkiv integration checklist (self-score)

- [x] Unique `PROJECT_ATTRIBUTE` on every create/query  
- [x] Multiple entity types with typed attributes  
- [x] `$owner` / `$creator` separation  
- [x] Differentiated `expiresIn` + accumulative `extendEntity`  
- [x] Relationships via shared attribute keys (`agentKey`, citations)  
- [x] Encrypted payloads + wallet-derived keys (Privacy)  
- [x] Batch / lifecycle patterns in `src/lib/batch-writer.ts`, tier promotion  

---

## Theme statement

**AI:** Agents expose only `recall(query, k)` and `act(action, citations[])`; citations reinforce memory on-chain.  
**Privacy:** Payloads are sealed client-side; key from `CORTEX_KEY_DERIVATION_v1` + SIWE — no central key escrow.

---

## More

| Doc | Contents |
|-----|----------|
| [README.md](../../README.md) | Setup, architecture diagram, env vars |
| [pitch.md](./pitch.md) | Judge script + talking points |
| [JUDGE_DEFENSE.md](./JUDGE_DEFENSE.md) | Adversarial Q&A |
| [../Arkiv.md](../Arkiv.md) | Empirical Braga protocol notes |
| [../ERC.md](../ERC.md) | Six ERCs we use vs skip |
| [../MIRROR.md](../MIRROR.md) | SQLite mirror design |
