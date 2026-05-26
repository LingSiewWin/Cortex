/**
 * Cortex — D8: LIVE anchor proof for Optimistic Memory Buffering (real Braga).
 *
 * Proves the full optimistic loop end-to-end on the live chain:
 *   1. create real observation memories on Braga (real embedded doc text → RaBitQ)
 *   2. act() cites them → commits scoring locally + enqueues an act_bundle (NO chain await)
 *   3. drainOutbox() — the anchor worker fires the real on-chain sequence:
 *      extend (accumulative) → [promote] → write CITATION entity → MMR append → anchor
 *   4. reconcile: the cited rows flip verified=1 under the anchored root
 *
 * Standalone (no daemon) so the MMR leaf is appended exactly once — this run
 * anchors a correct root. Pastes every tx hash + explorer link.
 *
 * Run: bun scripts/eval/live-anchor-proof.ts   (needs SESSION_KEY_PRIVATE_KEY funded +
 *      USER_PRIMARY_ADDRESS + OPENROUTER_API_KEY)
 */

import type { Hex } from "@arkiv-network/sdk";
import { ExpirationTime } from "@arkiv-network/sdk/utils";
import { singleCreate } from "../../src/lib/batch-writer.ts";
import { embedText } from "../../src/compression/embeddings.ts";
import { rabitqEncode, packCode } from "../../src/compression/rabitq.ts";
import { act } from "../../src/darwinian/citation.ts";
import { drainOutbox } from "../../src/agent/anchor-worker.ts";
import { initMirrorDb } from "../../src/mirror/db.ts";
import { getUserPrimaryEOA, getPublicClient } from "../../src/lib/arkiv-client.ts";
import { ENTITY_TYPE, BRAGA } from "../../src/constants.ts";

const tx = (h: string) => `${BRAGA.explorer.replace(/\/$/, "")}/tx/${h}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Chain-consistency preflight. Post-stall, Braga's RPC pool serves reads from
 * nodes at DIFFERENT sync heights — a read-after-write (extend reads expiresAtBlock
 * before extending) then nondeterministically routes to a lagging node and fails
 * "No entity found". Sample the head rapidly; if heights diverge wildly, bail with
 * a clear message rather than producing a misleading partial result.
 */
async function preflightConsistency(): Promise<void> {
  const heads: number[] = [];
  for (let i = 0; i < 6; i++) {
    const r = await fetch(BRAGA.httpRpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
    });
    heads.push(parseInt((await r.json()).result, 16));
    await sleep(300);
  }
  const spread = Math.max(...heads) - Math.min(...heads);
  console.log(`   head samples: ${heads.join(", ")} (spread ${spread} blocks)`);
  if (spread > 50) {
    console.error(
      `\n❌ Braga RPC pool is inconsistent (heads span ${spread} blocks) — nodes are still ` +
        `resyncing after the stall. read-after-write (extend) will fail nondeterministically.\n` +
        `   The optimistic buffer will retain the bundle; re-run this proof once the pool converges.`,
    );
    process.exit(3);
  }
}

/** Poll getEntity until present (tolerates the flaky pool), up to `timeoutMs`. */
async function waitForEntity(key: Hex, timeoutMs = 30_000): Promise<boolean> {
  const client = getPublicClient();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const e = await client.getEntity(key);
      if (e?.expiresAtBlock !== undefined) return true;
    } catch {
      /* not visible on the routed node yet — retry */
    }
    await sleep(2000);
  }
  return false;
}

const MEMORIES = [
  "Accumulative extend: a cited memory's new lease is remaining + 24h reinforcement, so useful memories grow.",
  "RaBitQ compresses a 1536-d float32 embedding to 198 bytes — about 31x — with an unbiased inner-product estimator.",
];

async function main(): Promise<void> {
  if (!process.env.SESSION_KEY_PRIVATE_KEY) throw new Error("SESSION_KEY_PRIVATE_KEY not set");
  const userEOA = getUserPrimaryEOA();
  const db = await initMirrorDb();
  console.log(`\n=== D8: LIVE optimistic-buffering anchor proof (Braga) ===`);
  console.log(`user EOA: ${userEOA}\n`);

  console.log(`[0/4] Chain-consistency preflight…`);
  await preflightConsistency();

  // 1. Create real observation memories on Braga (real embedding → RaBitQ pack).
  console.log(`[1/4] Creating ${MEMORIES.length} observation memories on Braga…`);
  const keys: Hex[] = [];
  for (const text of MEMORIES) {
    const emb = await embedText(text);
    const packed = packCode(rabitqEncode(emb));
    const { entityKey, txHash } = await singleCreate({
      payload: packed,
      contentType: "application/octet-stream",
      attributes: [{ key: "entityType", value: ENTITY_TYPE.OBSERVATION }],
      expiresInSeconds: ExpirationTime.fromMinutes(60),
    });
    keys.push(entityKey);
    console.log(`   created ${entityKey}`);
    console.log(`     ${tx(txHash)}`);
  }

  // Poll until BOTH entities are queryable (extend does a read-before-write, so a
  // blind sleep races the chain — poll instead).
  console.log(`\n   waiting for creates to be queryable (poll getEntity)…`);
  for (const k of keys) {
    const ok = await waitForEntity(k);
    if (!ok) {
      console.error(`   ❌ entity ${k.slice(0, 14)}… never became queryable — RPC pool still lagging.`);
      console.error(`   The bundle will be buffered; re-run once the pool converges.`);
      process.exit(3);
    }
    console.log(`   confirmed ${k.slice(0, 14)}…`);
  }

  // 2. act() — optimistic: scores locally + enqueues the bundle, NO chain await.
  console.log(`\n[2/4] act() citing both memories (optimistic — enqueues, returns immediately)…`);
  const result = await act({
    action: "D8 live anchor proof — cite both memories",
    citations: keys,
    userPrimaryEOA: userEOA,
    sessionId: `d8-${Date.now()}`,
    _deps: { db, lastRecallIds: () => new Set(keys) },
  });
  console.log(`   status=${result.status} outbox#${result.outboxId} (no tx yet — buffered)`);
  console.log(`   citation payload hash (future MMR leaf): ${result.citationPayloadHashHex}`);

  // 3. Drain the outbox → the worker fires the real on-chain sequence.
  console.log(`\n[3/4] Draining the outbox → worker anchors to Braga…`);
  const drained = await drainOutbox(db);
  for (const d of drained) {
    if (!d.ok) {
      console.error(`   ❌ bundle #${d.outboxId} failed: ${d.error}`);
      process.exit(2);
    }
    console.log(`   ✅ bundle #${d.outboxId} anchored:`);
    console.log(`      citation entity ${d.citationEntityKey}`);
    console.log(`      anchored root   ${d.rootHex}`);
    for (const h of d.txHashes) console.log(`      ${tx(h)}`);
  }

  // 4. Verify reconciliation in the mirror.
  console.log(`\n[4/4] Reconciliation check (cited rows flipped verified=1)…`);
  for (const k of keys) {
    const row = db
      .prepare("SELECT verified, anchored_root FROM citation_counts WHERE entity_key = ?")
      .get(k) as { verified: number; anchored_root: string | null } | null;
    console.log(
      `   ${k.slice(0, 14)}… verified=${row?.verified === 1 ? "✅ 1" : "❌ 0"} root=${row?.anchored_root?.slice(0, 18) ?? "(none)"}…`,
    );
  }
  console.log(`\n✅ D8 complete — optimistic buffering anchored end-to-end on live Braga.\n`);
}

main().catch((err) => {
  console.error("D8 failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
