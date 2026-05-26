/**
 * Cortex — OpenClaw `memory-arkiv` plugin harness (Goal 2 proof, real Braga).
 *
 * We don't have a running OpenClaw gateway, so this harness exercises the EXACT
 * tool surface the plugin registers — the pure adapter behind `memory_store` and
 * `memory_recall` (src/openclaw/adapter.ts) — against real Braga. It proves that
 * an OpenClaw agent calling these tools would: store a wallet-sealed memory on
 * Arkiv, then recall it back through Cortex's decay-aware engine.
 *
 * (To run inside a real gateway instead: `openclaw plugins install --link
 *  ./extensions/memory-arkiv` → `openclaw gateway restart` → `openclaw plugins
 *  inspect memory-arkiv --runtime --json`. See extensions/memory-arkiv/README.md.)
 *
 * Run:  CORTEX_USER_PRIVATE_KEY=0x<primary-eoa-key> bun scripts/openclaw-harness.ts
 */

import { startMirrorDaemon } from "../src/mirror/daemon";
import { getPublicClient } from "../src/lib/arkiv-client";
import { requirePayloadKey } from "../src/lib/payload-key";
import { getMirroredEntity } from "../src/mirror/replay";
import { _resetLastRecallIds } from "../src/darwinian/recall";
import { memoryRecall, memoryStore } from "../src/openclaw/adapter";

const MEMORY_TEXT =
  "User prefers TypeScript and pnpm; never scaffold new projects with npm or yarn.";
const QUERY = "what package manager and language does the user prefer?";

function extractEntityKey(toolText: string): `0x${string}` {
  const m = toolText.match(/0x[0-9a-fA-F]{64}/);
  if (!m) throw new Error(`could not find an entity key in memory_store output: ${toolText}`);
  return m[0] as `0x${string}`;
}

async function waitForMirror(entityKey: `0x${string}`, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const e = await getMirroredEntity(entityKey);
    if (e?.payload && e.payload.byteLength > 0) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`mirror did not sync ${entityKey} within ${timeoutMs}ms`);
}

async function main(): Promise<void> {
  console.log("\n=== memory-arkiv OpenClaw plugin — adapter harness (real Braga) ===\n");
  await requirePayloadKey();

  const timing = await getPublicClient().getBlockTiming();
  const daemon = await startMirrorDaemon({ fromBlock: timing.currentBlock, pollingIntervalMs: 1000 });

  try {
    console.log("[tool: memory_store] agent stores a memory via the plugin…");
    const stored = await memoryStore({ text: MEMORY_TEXT });
    const storedText = stored.content[0]!.text;
    console.log("        " + storedText);
    const entityKey = extractEntityKey(storedText);

    console.log("\n[sync] waiting for the mirror to ingest the sealed memory from chain…");
    await waitForMirror(entityKey, 60_000);
    console.log("        synced ✅");

    console.log("\n[tool: memory_recall] agent recalls it via the plugin…");
    _resetLastRecallIds();
    const recalled = await memoryRecall({ query: QUERY, k: 5 });
    const recalledText = recalled.content[0]!.text;
    console.log("        " + recalledText.replace(/\n/g, "\n        "));

    if (!recalledText.includes(entityKey)) {
      throw new Error("memory_recall did not surface the stored memory");
    }
    console.log(
      "\n✅ memory-arkiv plugin proven on Braga: an OpenClaw agent's memory_store → memory_recall " +
        "round-trips through Cortex (sealed write on Arkiv, decay-aware decrypted recall).",
    );
  } finally {
    daemon.stop();
  }
}

main().catch((err) => {
  console.error("\nopenclaw-harness failed:", err);
  process.exit(1);
});
