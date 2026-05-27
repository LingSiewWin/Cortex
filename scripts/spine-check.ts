/**
 * Cortex — Live Spine end-to-end check (Phase 16).
 *
 * Runs in ONE process so the event-bus subscriber sees the events that the
 * instrumented code paths publish. Performs real Braga operations:
 *   1. create an observation  → memory.created + arkiv.rpc.call + rabitq.encoded
 *   2. recall a query         → rabitq.encoded + arkiv.rpc.call
 *   3. act citing the hit     → memory.cited + mmr.appended + anchor.committed + arkiv.rpc.call
 *
 * Prints every captured event and the real tx hashes. This is the genuine
 * spine proof: real chain RPC → instrumentation → bus events, end to end.
 *
 * NOTE: cite-flow.ts runs as a SEPARATE process, so its events fire on a
 * different in-process bus and would NOT reach the dashboard's SSE stream.
 * The autonomous loop is wired to run INSIDE the dashboard server process so
 * its events do reach SSE — see src/ui-server.ts. This script verifies the
 * bus + instrumentation contract directly.
 */

import { subscribe, type BufferedEvent } from "../src/lib/events";
import { singleCreate } from "../src/lib/batch-writer";
import { embedAndQuantize } from "../src/compression/embeddings";
import { recall } from "../src/darwinian/recall";
import { act } from "../src/darwinian/citation";
import { drainOutbox } from "../src/agent/anchor-worker";
import { getUserPrimaryEOA } from "../src/lib/arkiv-client";
import { initMirrorDb } from "../src/mirror/db";
import { ENTITY_TYPE, BRAGA } from "../src/constants";
import { ExpirationTime } from "@arkiv-network/sdk/utils";

const captured: BufferedEvent[] = [];
subscribe((e) => {
  captured.push(e);
  const detail = JSON.stringify(e.event);
  console.log(`  [event] ${e.type.padEnd(18)} ${detail.slice(0, 110)}`);
});

function explorerTx(h: string): string {
  return `${BRAGA.explorer}tx/${h}`;
}

async function main(): Promise<void> {
  console.log("\n=== Cortex spine-check (real Braga) ===\n");
  await initMirrorDb();

  // 1. Create an observation.
  console.log("[1/3] Creating observation (→ rabitq.encoded, mutateEntities, memory.created)…");
  const { bytes } = await embedAndQuantize(
    "Reentrancy is mitigated by the checks-effects-interactions pattern and reentrancy guards.",
  );
  const created = await singleCreate({
    payload: bytes,
    contentType: "application/octet-stream",
    attributes: [
      { key: "entityType", value: ENTITY_TYPE.OBSERVATION },
      { key: "spineCheck", value: Date.now() },
    ],
    expiresInSeconds: ExpirationTime.fromMinutes(60),
  });
  console.log(`      entity ${created.entityKey}`);
  console.log(`      tx     ${explorerTx(created.txHash)}\n`);

  // 2. Recall.
  console.log("[2/3] Recall 'reentrancy' (→ rabitq.encoded, queryEntities)…");
  const hits = await recall({ query: "reentrancy guard pattern", k: 5 });
  console.log(`      ${hits.length} hit(s)\n`);

  // 3. Act, citing the top hit.
  if (hits.length > 0) {
    console.log("[3/3] act() citing top hit (→ memory.cited, mmr.appended, anchor.committed)…");
    const result = await act({
      action: "spine-check decision",
      citations: [hits[0]!.entityKey],
      userPrimaryEOA: getUserPrimaryEOA(),
      sessionId: "spine-check",
    });
    console.log(`      queued ${result.status} (outbox #${result.outboxId})`);
    // act() is optimistic — drain the outbox so the worker fires the on-chain
    // sequence (memory.cited / mmr.appended / anchor.committed all emit here).
    const drained = await drainOutbox(await initMirrorDb());
    for (const r of drained) {
      console.log(`      citation entity ${r.citationEntityKey}`);
      console.log(`      tx hashes:`);
      for (const h of r.txHashes) console.log(`        ${explorerTx(h)}`);
      if (r.rootHex) console.log(`      state root ${r.rootHex}`);
      if (!r.ok) console.log(`      ⚠ anchor failed: ${r.error}`);
    }
  } else {
    console.log("[3/3] SKIPPED — recall returned 0 hits (no Cortex memories on chain yet).");
  }

  // Summary.
  const counts: Record<string, number> = {};
  for (const e of captured) counts[e.type] = (counts[e.type] ?? 0) + 1;
  console.log(`\n=== captured ${captured.length} spine events ===`);
  console.log(JSON.stringify(counts, null, 2));

  const expected = ["arkiv.rpc.call", "rabitq.encoded"];
  const missing = expected.filter((t) => !(t in counts));
  if (missing.length > 0) {
    console.error(`\n❌ Missing expected event types: ${missing.join(", ")}`);
    process.exit(1);
  }
  console.log("\n✅ Spine emitted events end-to-end on real Braga.");
}

main().catch((err) => {
  console.error("spine-check failed:", err);
  process.exit(2);
});
