# Scripts

CLI utilities for Cortex. **Judges:** you only need `seed`, `faucet-check`, and `sovereignty-proof` for review; the rest is development.

| Script | Command | Purpose |
|--------|---------|---------|
| `seed-memories.ts` | `bun run seed` | Write initial memories to Braga (run once before loop) |
| `faucet-check.ts` | `bun run faucet-check` | Verify session key has GLM |
| `sovereignty-proof.ts` | `bun scripts/sovereignty-proof.ts` | Encrypted create → read round-trip + explorer link |
| `build-plugin.ts` | `bun run build:plugin` | Bundle `cortex-plugin/dist/` |
| `derive-user-signature.ts` | `bun scripts/derive-user-signature.ts` | Derive `CORTEX_USER_SIGNATURE` for sealed recall |
| `cite-flow.ts` | `bun run cite-flow` | Scripted multi-step Braga judge (dev) |
| `backfill.ts` | `bun run backfill` | Mirror backfill from chain events (dev) |

`scripts/eval/` — recall ablations and benchmarks; not part of the submission path.
