# Braga distill-run proof — semantic RULE tier

**Date:** 2026-05-30  
**Network:** Braga testnet (chainId `60138453102`)  
**Command:** `ANTHROPIC_API_KEY= bun run distill-run` (successful run after preflight)  
**Session EOA:** `0x576021C3C8cd5e8b3d36CE7DFF964EC056A938f4`  
**Owner EOA ($owner):** `0xD3501111b0DdCC9D0E1Acf45340226885b28A137`

## Preflight

`bun run faucet-check` passed with **~0.002 GLM** (low-balance warning; writes still succeeded).

**Secrets:** `CORTEX_USER_SIGNATURE` not set in `.env`; wallet material loaded from `~/.cortex/config.json` (`userSignature`, `sessionKeyPrivate`) per `src/lib/cortex-config.ts` fallbacks.

## Successful run summary

Working → episodic → semantic consolidation completed on Braga:

1. Observation created on-chain  
2. Five cite rounds across three distinct sessions (`sess-a`, `sess-b`, `sess-c`)  
3. `distillIfReady` wrote a RULE entity and transferred ownership to the user EOA  

**Distillation mode:** offline synthesizer (`ANTHROPIC_API_KEY` cleared — `.env` key has zero Anthropic credits; first attempt with the key failed with HTTP 400).

### Observation (working tier)

| Field | Value |
|---|---|
| Entity key | `0xc75cf9094da4b25ed18c4e9c39b90c2d260eee1be298f11b8c607ba58b175b31` |
| Create tx | [0xd5cadf16df07538bbe2c6495f2d8359e9bea7330023ffd25f24bb2782b98f9d4](https://explorer.braga.hoodi.arkiv.network/tx/0xd5cadf16df07538bbe2c6495f2d8359e9bea7330023ffd25f24bb2782b98f9d4) |

### Cite rounds (local Darwinian state)

| Round | Session | Episodic promotion |
|---|---|---|
| 1 | `sess-a` | no |
| 2 | `sess-b` | **yes** |
| 3 | `sess-c` | no |
| 4 | `sess-a` | no |
| 5 | `sess-b` | **yes** |

Post-run citation stats: `count=5`, `distinctSessions=3`, `promotedTo=rule`.

`act()` enqueues on-chain extend/citation bundles to the SQLite outbox (ids `5724`–`5728` for this run). A large historical pending backlog (~4.4k rows) prevented those bundles from anchoring during this session; the semantic threshold and RULE write are driven by committed local citation state, which is the mechanism `distill-run` exercises.

### RULE entity (semantic tier)

| Field | Value |
|---|---|
| Entity key | `0xc289df757a5a03dbce9acc131db7c89f076941b9f8651baa036dbb1f833c5fd6` |
| Create tx | [0xfe1e14083619128d41ee0ff72379d98a0b9453ee89c54bc38130be8f4e3ac523](https://explorer.braga.hoodi.arkiv.network/tx/0xfe1e14083619128d41ee0ff72379d98a0b9453ee89c54bc38130be8f4e3ac523) |
| Ownership transfer tx | [0xd4593d8f628b31cd9185c18a69d9e6bdec047a084ec98397fe12fe1117394b4a](https://explorer.braga.hoodi.arkiv.network/tx/0xd4593d8f628b31cd9185c18a69d9e6bdec047a084ec98397fe12fe1117394b4a) |
| Owner after transfer | `0xD3501111b0DdCC9D0E1Acf45340226885b28A137` (user primary EOA) |
| Created at block | `#1083941` |

**Distilled rule text (offline synthesizer):**

> Rule: episode:0xc75cf909 attrs:[entityType=observation, marker=rug-policy, project=cortex-ethns-2026, distillRun=1780149256325]

## Earlier attempts (same session)

| Attempt | Outcome |
|---|---|
| Default `.env` (`ANTHROPIC_API_KEY` set) | Failed at step 3 — Anthropic 400 (credit balance too low) after observation + cites succeeded |
| `ANTHROPIC_API_KEY=` + transient Braga RPC | Failed at step 3 — `getEntity` context cancelled; observation `0x4fd719b1…` reached semantic threshold locally but distill returned null |

## Console excerpt (successful run)

```
=== Cortex distill-run (RULE tier, real Braga) ===

[1] Creating observation…
    0xc75cf9094da4b25ed18c4e9c39b90c2d260eee1be298f11b8c607ba58b175b31
    https://explorer.braga.hoodi.arkiv.network/tx/0xd5cadf16df07538bbe2c6495f2d8359e9bea7330023ffd25f24bb2782b98f9d4

[2] Citing across 3 sessions × 5 rounds …
    round 1 [sess-a] cited 0xc75cf909… promoted=false
    round 2 [sess-b] cited 0xc75cf909… promoted=true
    round 3 [sess-c] cited 0xc75cf909… promoted=false
    round 4 [sess-a] cited 0xc75cf909… promoted=false
    round 5 [sess-b] cited 0xc75cf909… promoted=true

[3] Running distillIfReady (offline synthesizer — no ANTHROPIC_API_KEY)…

✅ RULE distilled + written on Braga
```
