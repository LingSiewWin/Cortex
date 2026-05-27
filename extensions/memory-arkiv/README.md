# memory-arkiv — Cortex memory plugin for OpenClaw

Fills [OpenClaw](https://github.com/openclaw/openclaw)'s single active **memory slot** with
Cortex's sovereign, decay-aware engine on the Arkiv blockchain — instead of a local store.

| OpenClaw tool | Cortex mapping |
|---|---|
| `memory_store` | RaBitQ-compress → seal with your wallet key → write to Arkiv (1h lease, grows on citation) |
| `memory_recall` | decay-aware, utility-weighted recall; decrypted in RAM with your wallet |

**Why replace the local slot?** OpenClaw's built-in memory is local files on one machine.
Cortex makes the same memory **portable across devices**, **verifiable to other agents** (MMR
anchoring), and **economically self-pruning** (useless memories decay for free) — while staying
**sovereign**: the chain holds ciphertext, and only your wallet can read it.

## Layout

- `index.ts` — the plugin shell: `definePluginEntry` + `api.registerTool` for the two tools.
- `openclaw.plugin.json` — manifest (`kind: "memory"`, `contracts.tools`, `preferOver: memory-core`).
- The tool bodies live in Cortex at `../../src/openclaw/adapter.ts` (typechecked + unit-tested there);
  this package only wraps them, so it carries no Cortex logic of its own.

## Install (local dev, per docs.openclaw.ai/plugins/manage-plugins)

```bash
openclaw plugins install --link ./extensions/memory-arkiv
openclaw gateway restart
openclaw plugins inspect memory-arkiv --runtime --json   # proves the tools registered
```

Select it for the memory slot (per docs.openclaw.ai/plugins/memory-lancedb):

```json5
// openclaw config
plugins: {
  slots: { memory: "memory-arkiv" }
}
```

## Environment

The plugin reuses Cortex's runtime env (Braga RPC is built in):

- `SESSION_KEY_PRIVATE_KEY` — funded session key that pays for Arkiv writes.
- `CORTEX_USER_SIGNATURE` **or** `CORTEX_USER_PRIVATE_KEY` — the wallet that seals/opens memories.
- `COHERE_API_KEY` (or configured embedding provider).

## Try it yourself

The adapter ships in-repo; we have **not** run it inside a live OpenClaw gateway in this
environment. Validate the tool surface against Braga first:

```bash
CORTEX_USER_PRIVATE_KEY=0x<primary-eoa-key> bun scripts/openclaw-harness.ts
```

That runs `memory_store` → mirror sync → `memory_recall` through the same code the plugin
wraps. Then install the plugin and point `plugins.slots.memory` at `memory-arkiv` — see
[OpenClaw plugin docs](https://docs.openclaw.ai/plugins/manage-plugins).
