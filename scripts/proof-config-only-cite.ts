/**
 * Cortex — PROOF: config-only fresh-installer cortex_act on Braga.
 *
 * Simulates a fresh installer who ran `cortex auth` (so ~/.cortex/config.json holds
 * owner + session key + signature + embedding key) but never exported any env var.
 * Before the credential-centralization fix, the MCP cortex_act path read the owner
 * from process.env.USER_PRIMARY_ADDRESS ONLY and failed here. Now it resolves from
 * config. This script proves both: (1) the owner resolves from config, and (2) a
 * real accumulative extend fires on Braga.
 *
 * Cheap by design: it does NOT create entities. It recalls existing memories from
 * the local mirror and cites them, firing one extend bundle.
 *
 * Run:  bun scripts/proof-config-only-cite.ts
 */

// --- Simulate "fresh installer": no owner env var. resolveCredentials() must
//     fall back to ~/.cortex/config.json. (Session key may come from either;
//     the bug under test was specifically the owner read.) ---
delete process.env.USER_PRIMARY_ADDRESS;
delete process.env.CORTEX_USER_PRIVATE_KEY;

import type { Hex } from "@arkiv-network/sdk";
import { resolveCredentials } from "../src/lib/credentials";
import { recall } from "../src/darwinian/recall";
import { act } from "../src/darwinian/citation";
import { drainOutbox } from "../src/agent/anchor-worker";
import { initMirrorDb } from "../src/mirror/db";
import { BRAGA } from "../src/constants";

const tx = (h: string) => `${BRAGA.explorer}tx/${h}`;

async function main() {
  console.log("\n=== Cortex proof — config-only fresh-installer cortex_act ===\n");

  // 1. Prove the FIX: owner resolves from ~/.cortex/config.json with env unset.
  const creds = resolveCredentials();
  console.log("resolveCredentials().source:", JSON.stringify(creds.source));
  console.log("owner EOA              :", creds.ownerEOA);
  if (!creds.ownerEOA) {
    console.error("\n❌ No owner resolved. Run `cortex auth` to write ~/.cortex/config.json.");
    process.exit(1);
  }
  if (creds.source.owner !== "config") {
    console.warn(
      `\n⚠️  owner resolved from '${creds.source.owner}', not 'config'. ` +
        "An env var is still set — the fresh-installer simulation isn't clean, " +
        "but the resolution path is the same.",
    );
  } else {
    console.log("✅ FIX confirmed: owner came from ~/.cortex/config.json (env was unset).\n");
  }

  // 2. recall existing memories from the local mirror.
  const query = "session key ownership and accumulative extend on Arkiv";
  console.log(`[recall] "${query}"`);
  const hits = await recall({ query, k: 5 });
  console.log(`[recall] ${hits.length} candidate(s):`);
  for (const h of hits.slice(0, 5)) {
    console.log(`   ${h.entityKey.slice(0, 14)}…  type=${h.entityType}  score=${h.score.toFixed(4)}`);
  }
  if (hits.length === 0) {
    console.error("\n❌ recall returned nothing — mirror has no citable memories. Seed first (bun run seed).");
    process.exit(3);
  }

  // 3. act() — cite the top hits. Owner comes from the fix above.
  const citations = hits.slice(0, 2).map((h) => h.entityKey as Hex);
  console.log(`\n[act] citing ${citations.length} memory(ies) with config-resolved owner…`);
  const db = await initMirrorDb();
  const res = await act({
    action: "PROOF: verify config-only owner resolution fires a real extend",
    citations,
    userPrimaryEOA: creds.ownerEOA as Hex,
  });
  console.log(`[act] status=${res.status} outboxId=${res.outboxId ?? "—"}`);
  if (res.status === "noop") {
    console.error("\n❌ act() found no valid citation (recall/act mismatch). No extend fired.");
    process.exit(3);
  }

  // 4. Drain the outbox → real extendEntity tx on Braga.
  console.log("\n[drain] flushing the act bundle to Braga (real extendEntity)…");
  const drained = await drainOutbox(db);
  const txHashes = drained.flatMap((r) => r.txHashes ?? []);
  if (txHashes.length === 0) {
    console.error(
      "\n❌ Drain produced no tx — the cited memories may be expired on-chain " +
        "(Braga auto-deletes expired entities; extend reverts 'no entity'). " +
        "Re-seed and retry: bun run seed.",
    );
    process.exit(4);
  }
  console.log("\n✅ Real Braga extend fired. Proof:");
  for (const h of txHashes) console.log(`   ${h}\n      → ${tx(h)}`);
  console.log("\n=== DONE — config-only cortex_act produced a real on-chain extend. ===\n");
}

main().catch((err) => {
  console.error("\n❌ proof failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
