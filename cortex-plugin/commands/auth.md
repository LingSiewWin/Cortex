---
name: cortex-auth
description: Connect your wallet to Cortex — one signature sets up sovereign, wallet-encrypted memory (no pasted keys, no env vars). Run this once after installing the plugin.
---

# Connect Cortex (`/cortex-auth`)

Run the Cortex onboarding flow: it generates a local session key, opens your
browser to connect your wallet, you sign once, and it writes `~/.cortex/config.json`
so the plugin can read/write your sovereign memory on Arkiv.

> **Requires [`bun`](https://bun.sh) on your PATH.** The plugin's hooks, MCP server,
> and this command all run as bundled `bun` scripts. If `bun` isn't installed you'll
> see `command not found: bun` — install it (`curl -fsSL https://bun.sh/install | bash`)
> and re-run. No other global install is needed.

Run this command:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/dist/cortex-auth.js"
```

What happens:
1. A local page opens in your browser — click **Connect wallet & sign** (MetaMask/Rabby).
2. Optionally paste an embedding API key (OpenAI / OpenRouter / Voyage / Cohere) — stored locally only.
3. Return to the terminal. Fund the printed session-key address via the Braga faucet so it can write.

No private keys are pasted; only your signature is sent, and only to the local app on your machine.
