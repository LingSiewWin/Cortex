#!/usr/bin/env bun
/**
 * Cortex — Obsidian sync daemon launcher.
 *
 *   CORTEX_VAULT_PATH=~/MyVault bun run scripts/obsidian-sync.ts
 *
 * Watches the vault and seals every changed `.md` note into a sovereign Arkiv
 * document entity (full text + embeddings), stamping the recovery block back
 * into each file. Requires:
 *   - SESSION_KEY_PRIVATE_KEY   (write path → Braga)
 *   - OPENROUTER_API_KEY or COHERE_API_KEY  (embeddings)
 *   - CORTEX_USER_SIGNATURE or CORTEX_USER_PRIVATE_KEY  (seal key)
 */

import { startVaultDaemon } from "../src/obsidian/sync-daemon.ts";

const vaultPath = process.env.CORTEX_VAULT_PATH;
if (!vaultPath) {
  console.error(
    "CORTEX_VAULT_PATH missing. Set it to your Obsidian vault root, e.g.\n" +
      "  CORTEX_VAULT_PATH=~/MyVault bun run scripts/obsidian-sync.ts",
  );
  process.exit(1);
}

const handle = startVaultDaemon({ vaultPath });

const shutdown = () => {
  handle.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Park forever; the watcher drives all work via its callbacks.
await new Promise<void>(() => {});
