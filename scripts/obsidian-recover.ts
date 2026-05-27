#!/usr/bin/env bun
/**
 * Cortex — Obsidian vault recovery launcher ("laptop died → rebuild from wallet").
 *
 *   CORTEX_RECOVER_OUT=./recovered-vault bun run scripts/obsidian-recover.ts
 *
 * Queries every live `document` entity for this project, decrypts with the
 * wallet-derived payload key, and reconstructs each note as a `.md` file under
 * the output directory. Requires:
 *   - CORTEX_USER_SIGNATURE or CORTEX_USER_PRIVATE_KEY  (decrypt key)
 *   - SESSION_KEY_PRIVATE_KEY  (cortexQuery defaults to createdBy=SESSION_KEY)
 */

import { recoverVault } from "../src/obsidian/recover.ts";

const outDir = process.env.CORTEX_RECOVER_OUT ?? "./recovered-vault";

const result = await recoverVault({
  outDir,
  log: (...args) => console.log(...args),
});

console.log(
  `\nDone. Recovered ${result.recovered.length} note(s) into ${outDir}.` +
    (result.skipped.length > 0
      ? ` Skipped ${result.skipped.length}: ${result.skipped
          .map((s) => `${s.key.slice(0, 10)}…(${s.reason})`)
          .join(", ")}`
      : ""),
);
