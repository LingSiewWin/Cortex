/**
 * Cortex — GROUND-TRUTH probe: is Braga's `extend` ADDITIVE or REPLACE?
 *
 * This resolves a contradiction between (a) a source-read claim that deployed
 * op-geth `ExtendBTL` is additive (`expiresAt += n`, no guard) and (b) our own
 * `docs/Arkiv.md` empirical note that extend is REPLACE (`newExpiresAt =
 * currentBlock + btl`, reverts if not increased). It matters because
 * `src/darwinian/extend.ts` sets `expiresIn = remaining + reinforcement`,
 * which is correct ONLY under REPLACE; under ADDITIVE it double-counts `remaining`.
 *
 * Method: create an entity with a known btl, record (E0 = expiresAtBlock,
 * C0 = head). Wait a few blocks. Extend by a known `expiresIn`, record
 * (E1, C1). Then:
 *   - REPLACE  ⇒ E1 ≈ C1 + extendBlocks
 *   - ADDITIVE ⇒ E1 ≈ E0 + extendBlocks
 * These differ by ~the remaining-at-extend (≈ E0 − C1), so they're distinguishable.
 *
 * Run: bun scripts/eval/extend-semantics-probe.ts  (needs a funded SESSION_KEY)
 */

import type { Hex } from "@arkiv-network/sdk";
import { ExpirationTime } from "@arkiv-network/sdk/utils";
import { singleCreate } from "../../src/lib/batch-writer.ts";
import { getPublicClient, getWalletClient, instrumentRpc } from "../../src/lib/arkiv-client.ts";
import { ENTITY_TYPE, BRAGA } from "../../src/constants.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BLOCK_TIME = 2; // seconds/block (pinned)

async function head(): Promise<number> {
  const r = await fetch(BRAGA.httpRpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
  });
  return parseInt((await r.json()).result, 16);
}

async function expiresAt(key: Hex): Promise<number> {
  const e = await getPublicClient().getEntity(key);
  if (e?.expiresAtBlock === undefined) throw new Error("no expiresAtBlock");
  return Number(e.expiresAtBlock);
}

async function waitQueryable(key: Hex, timeoutMs = 40_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await expiresAt(key);
      return;
    } catch {
      await sleep(2000);
    }
  }
  throw new Error("entity never became queryable");
}

async function main(): Promise<void> {
  if (!process.env.SESSION_KEY_PRIVATE_KEY) throw new Error("SESSION_KEY_PRIVATE_KEY not set");

  const createBtlSec = 200; // 100 blocks
  const extendBtlSec = 1000; // 500 blocks
  const extendBlocks = extendBtlSec / BLOCK_TIME;

  console.log(`\n=== extend-semantics probe (live Braga) ===`);
  console.log(`create btl=${createBtlSec}s (${createBtlSec / BLOCK_TIME} blk), extend expiresIn=${extendBtlSec}s (${extendBlocks} blk)\n`);

  // 1. Create.
  const { entityKey, txHash } = await singleCreate({
    payload: new Uint8Array([1, 2, 3, 4]),
    contentType: "application/octet-stream",
    attributes: [{ key: "entityType", value: ENTITY_TYPE.OBSERVATION }],
    expiresInSeconds: ExpirationTime.fromSeconds
      ? ExpirationTime.fromSeconds(createBtlSec)
      : createBtlSec,
  });
  console.log(`created ${entityKey}  (${txHash.slice(0, 14)}…)`);
  await waitQueryable(entityKey);

  const E0 = await expiresAt(entityKey);
  const C0 = await head();
  console.log(`E0 (expiresAtBlock after create) = ${E0}`);
  console.log(`C0 (head now)                    = ${C0}   → remaining ≈ ${E0 - C0} blocks`);

  // 2. Let a few blocks pass so C1 > C0 and the two hypotheses separate.
  console.log(`\nwaiting ~12s (~6 blocks) before extend…`);
  await sleep(12_000);

  // 3. Extend with a known expiresIn via the raw SDK (NOT our remaining+reinforcement).
  const wallet = getWalletClient();
  const C1_before = await head();
  const ext = await instrumentRpc(
    "extendEntity",
    () => wallet.extendEntity({ entityKey, expiresIn: extendBtlSec }),
    (r) => ({ txHash: r.txHash, byteSize: 32 }),
  );
  console.log(`extended (${ext.txHash.slice(0, 14)}…), head at send ≈ ${C1_before}`);
  await sleep(6000); // let it mine

  const E1 = await expiresAt(entityKey);
  const C1 = await head();
  console.log(`\nE1 (expiresAtBlock after extend) = ${E1}`);
  console.log(`C1 (head now)                    = ${C1}`);

  // 4. Diagnose.
  const replacePredict = C1_before + extendBlocks; // newExpiresAt = currentBlock + btl
  const additivePredict = E0 + extendBlocks; //         expiresAt += btl
  const dReplace = Math.abs(E1 - replacePredict);
  const dAdditive = Math.abs(E1 - additivePredict);
  console.log(`\n--- hypotheses (extendBlocks=${extendBlocks}) ---`);
  console.log(`REPLACE  predicts E1 ≈ C_send + ${extendBlocks} = ${replacePredict}   (|Δ|=${dReplace})`);
  console.log(`ADDITIVE predicts E1 ≈ E0 + ${extendBlocks}     = ${additivePredict}   (|Δ|=${dAdditive})`);
  const verdict =
    dReplace <= dAdditive
      ? "REPLACE (newExpiresAt = currentBlock + btl) — our extend.ts math is CORRECT"
      : "ADDITIVE (expiresAt += btl) — our extend.ts OVER-EXTENDS; remove the +remaining term";
  console.log(`\n🔬 VERDICT: ${verdict}`);
  console.log(`   net gain this extend: ${E1 - E0} blocks (${(E1 - E0) * BLOCK_TIME}s)`);
  console.log(`   explorer: ${BRAGA.explorer.replace(/\/$/, "")}/tx/${ext.txHash}\n`);
}

main().catch((err) => {
  console.error("probe failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
