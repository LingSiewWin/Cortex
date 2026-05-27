#!/usr/bin/env bun
/**
 * Build the STANDALONE Cortex plugin bundles.
 *
 * Bundles each plugin entrypoint (hooks + drainer + MCP server) into a single
 * self-contained .js under cortex-plugin/dist/ — engine + npm deps inlined, the
 * mirror schema inlined (via the `with { type: "text" }` import), so the plugin
 * runs WITHOUT the Cortex repo on a stranger's machine. The only runtime
 * requirement is `bun` (the bundles use bun:sqlite + bun built-ins, kept external).
 *
 * Run: `bun run build:plugin`. hooks.json + .mcp.json reference dist/*.js.
 */

import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "cortex-plugin", "dist");

const ENTRYPOINTS = [
  { in: "scripts/cortex-hook-capture.ts", out: "cortex-hook-capture.js" },
  { in: "scripts/cortex-hook-recall.ts", out: "cortex-hook-recall.js" },
  { in: "scripts/cortex-drain.ts", out: "cortex-drain.js" },
  { in: "scripts/cortex-auth.ts", out: "cortex-auth.js" },
  { in: "src/mcp/server.ts", out: "cortex-mcp.js" },
];

if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });

let failed = 0;
for (const e of ENTRYPOINTS) {
  const result = await Bun.build({
    entrypoints: [join(ROOT, e.in)],
    outdir: OUT,
    target: "bun", // bun:sqlite + bun built-ins stay external, resolved at runtime
    naming: e.out,
    minify: false, // keep readable for debugging; size is fine
  });
  if (!result.success) {
    failed++;
    console.error(`✗ ${e.in} → ${e.out}`);
    for (const log of result.logs) console.error("  ", log.message);
  } else {
    const f = Bun.file(join(OUT, e.out));
    const kb = ((await f.size) / 1024).toFixed(0);
    console.error(`✓ ${e.in} → dist/${e.out} (${kb} KB)`);
  }
}

// The `cortex auth` connect page is a RainbowKit React app. It must be a *browser*
// build (NOT nested inside the target:"bun" server bundle above — that mis-targets
// RainbowKit's lazy WalletConnect/qrcode deps and pulls Node builtins). Built on its
// own with target:"browser", Bun resolves the browser fields cleanly. cortex-auth.js
// serves these static files at runtime (it does NOT import the HTML).
const CONNECT_OUT = join(OUT, "connect");
const connectResult = await Bun.build({
  entrypoints: [join(ROOT, "ui", "connect", "index.html")],
  outdir: CONNECT_OUT,
  target: "browser",
  minify: true,
  naming: { entry: "[dir]/[name].[ext]", chunk: "[name]-[hash].[ext]", asset: "[name]-[hash].[ext]" },
});
if (!connectResult.success) {
  failed++;
  console.error(`✗ ui/connect → dist/connect/`);
  for (const log of connectResult.logs) console.error("  ", log.message);
} else {
  let bytes = 0;
  for (const o of connectResult.outputs) bytes += o.size;
  console.error(`✓ ui/connect/index.html → dist/connect/ (${(bytes / 1024).toFixed(0)} KB)`);
}

if (failed > 0) {
  console.error(`\n${failed} bundle(s) failed.`);
  process.exit(1);
}
console.error(`\nStandalone plugin bundles written to cortex-plugin/dist/.`);
