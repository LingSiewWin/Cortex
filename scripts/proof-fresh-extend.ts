/**
 * Cortex — PROOF: real accumulative extend on a LIVE Braga entity, config-only.
 *
 * The companion proof (proof-config-only-cite.ts) showed the owner resolves from
 * ~/.cortex/config.json with env unset and act() enqueues — but the mirror's
 * memories had expired on-chain so no extend fired. This script closes the loop:
 * it creates ONE fresh observation (live, 1h lease) and fires the accumulative
 * extend primitive on it, capturing the real extendEntity tx and the
 * before/after expiresAtBlock increase.
 *
 * Run:  bun scripts/proof-fresh-extend.ts   (spends a little Braga GLM — 2 writes)
 */

// Fresh-installer simulation: no owner env var → resolveCredentials() falls back
// to ~/.cortex/config.json.
delete process.env.USER_PRIMARY_ADDRESS;
delete process.env.CORTEX_USER_PRIVATE_KEY;

import { ExpirationTime } from "@arkiv-network/sdk/utils";
import type { Hex } from "@arkiv-network/sdk";
import { resolveCredentials } from "../src/lib/credentials";
import { singleCreate } from "../src/lib/batch-writer";
import { getPublicClient } from "../src/lib/arkiv-client";
import { reinforce } from "../src/darwinian/extend";
import { rabitqEncode, packCode } from "../src/compression/rabitq";
import { ENTITY_TYPE, BRAGA } from "../src/constants";

const tx = (h: string) => `${BRAGA.explorer}tx/${h}`;
const ent = (k: string) => `${BRAGA.explorer}entities/${k}`;

function synthVector(seed: number): Float32Array {
  let s = seed >>> 0;
  const v = new Float32Array(1536);
  let norm = 0;
  for (let i = 0; i < 1536; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const x = s / 0x1_0000_0000 - 0.5;
    v[i] = x;
    norm += x * x;
  }
  const inv = 1 / Math.sqrt(norm);
  for (let i = 0; i < 1536; i++) v[i]! *= inv;
  return v;
}

async function main() {
  console.log("\n=== Cortex proof — real accumulative extend on a live Braga entity ===\n");

  const creds = resolveCredentials();
  console.log("resolveCredentials().source:", JSON.stringify(creds.source));
  console.log("owner EOA:", creds.ownerEOA, `(from '${creds.source.owner}')\n`);

  // 1. Create ONE fresh observation (live, 1h lease).
  console.log("[create] one fresh observation (1h lease)…");
  const seed = Number(process.hrtime.bigint() % 2_000_000_000n);
  const created = await singleCreate({
    payload: packCode(rabitqEncode(synthVector(seed))),
    contentType: "application/octet-stream",
    attributes: [
      { key: "entityType", value: ENTITY_TYPE.OBSERVATION },
      { key: "marker", value: `proof-extend-${seed}` },
    ],
    expiresInSeconds: ExpirationTime.fromMinutes(60),
  });
  const entityKey = created.entityKey as Hex;
  console.log(`   entityKey : ${entityKey}`);
  console.log(`   create tx : ${created.txHash}`);
  console.log(`             → ${tx(created.txHash)}`);
  console.log(`             → ${ent(entityKey)}\n`);

  // 2. Read expiresAtBlock BEFORE the extend.
  const before = await getPublicClient().getEntity(entityKey);
  console.log(`[before] expiresAtBlock = ${before.expiresAtBlock}`);

  // 3. Fire the accumulative extend (+24h) — the Darwinian reinforcement primitive.
  console.log("\n[extend] reinforce(+24h) — real extendEntity on Braga…");
  const extendTx = await reinforce(entityKey, 24 * 60 * 60);
  console.log(`   extend tx : ${extendTx}`);
  console.log(`             → ${tx(extendTx)}`);

  // 4. Read expiresAtBlock AFTER — must have increased by ~24h / 2s = 43200 blocks.
  const after = await getPublicClient().getEntity(entityKey);
  console.log(`\n[after]  expiresAtBlock = ${after.expiresAtBlock}`);
  const delta = Number((after.expiresAtBlock ?? 0n) - (before.expiresAtBlock ?? 0n));
  console.log(`[delta]  +${delta} blocks (~${(delta * 2 / 3600).toFixed(2)} h added)`);

  if (delta <= 0) {
    console.error("\n❌ expiresAtBlock did not increase — extend did not take effect.");
    process.exit(1);
  }
  console.log("\n✅ PROOF COMPLETE — config-resolved owner, real on-chain accumulative extend.\n");
}

main().catch((err) => {
  console.error("\n❌ proof failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
