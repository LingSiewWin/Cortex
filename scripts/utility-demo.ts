/**
 * Cortex — SEDM-fusion utility-weight proof (real Braga).
 *
 * Demonstrates the headline behavior of the SEDM×Cortex fusion
 * (docs/research/2026-05-23-sedm-fusion-design.md): citing a memory repeatedly
 * evolves its utility weight above the neutral baseline, which scales its
 * on-chain lease beyond the flat base — useful memories earn longer life,
 * replacing Cortex's old crude "+24h per citation".
 *
 * Run:  bun run utility-demo
 */

import { embedAndQuantize } from "../src/compression/embeddings";
import { singleCreate } from "../src/lib/batch-writer";
import { recall } from "../src/darwinian/recall";
import { act } from "../src/darwinian/citation";
import { getUserPrimaryEOA } from "../src/lib/arkiv-client";
import { initMirrorDb, getMemoryWeight } from "../src/mirror/db";
import { leaseSeconds } from "../src/darwinian/utility";
import { ENTITY_TYPE, BRAGA, REINFORCEMENT, UTILITY } from "../src/constants";
import { ExpirationTime } from "@arkiv-network/sdk/utils";

const TEXT = "Always verify a contract is audited and liquidity is locked before integrating it.";
const QUERY = "should I integrate this unaudited contract?";
const BASE = REINFORCEMENT.workingReinforcementSeconds;

async function main(): Promise<void> {
  console.log("\n=== Cortex utility-demo (SEDM fusion, real Braga) ===\n");
  const db = await initMirrorDb();
  const eoa = getUserPrimaryEOA();

  console.log("[setup] creating observation…");
  const { bytes } = await embedAndQuantize(TEXT);
  const created = await singleCreate({
    payload: bytes,
    contentType: "application/octet-stream",
    attributes: [
      { key: "entityType", value: ENTITY_TYPE.OBSERVATION },
      { key: "marker", value: "audit-policy" },
      { key: "utilityDemo", value: Date.now() },
    ],
    expiresInSeconds: ExpirationTime.fromMinutes(60),
  });
  const key = created.entityKey;
  console.log(`        ${key}`);
  console.log(`        ${BRAGA.explorer}tx/${created.txHash}\n`);

  console.log(
    `[rounds] base lease = ${BASE}s (${(BASE / 3600).toFixed(0)}h). ` +
      `Weight starts at wInit=${UTILITY.wInit}; lease scales once weight exceeds it.\n`,
  );
  console.log("  round | priorWeight | lease(prior) | →newWeight");
  console.log("  ------+-------------+--------------+-----------");

  for (let i = 1; i <= 4; i++) {
    const hits = await recall({ query: QUERY, k: 5 });
    const target = hits.find((h) => h.entityKey === key) ?? hits[0];
    if (!target) {
      console.error("  recall returned nothing — aborting");
      process.exit(2);
    }
    const priorWeight = getMemoryWeight(db, key, UTILITY.wInit);
    const leaseForThis = leaseSeconds(BASE, priorWeight);
    await act({
      action: `evaluate integration (round ${i})`,
      citations: [target.entityKey],
      userPrimaryEOA: eoa,
      sessionId: `s${i}`, // distinct sessions strengthen the signal
      outcome: 1, // this memory led to a good decision
    });
    const newWeight = getMemoryWeight(db, key, UTILITY.wInit);
    console.log(
      `    ${i}   |   ${priorWeight.toFixed(3)}   |  ${String(leaseForThis).padStart(8)}s | ${newWeight.toFixed(3)}`,
    );
  }

  const finalWeight = getMemoryWeight(db, key, UTILITY.wInit);
  const finalLease = leaseSeconds(BASE, finalWeight);
  console.log(
    `\n  final weight ${finalWeight.toFixed(3)} → next lease ${finalLease}s ` +
      `(${(finalLease / BASE).toFixed(2)}× base)`,
  );
  if (finalWeight <= UTILITY.wInit) {
    console.error("\n❌ weight did not climb above baseline — fusion not engaging.");
    process.exit(3);
  }
  console.log(
    "\n✅ SEDM fusion proven on Braga: repeated useful citations evolved the " +
      "weight above baseline, scaling the on-chain lease past flat base.",
  );
}

main().catch((err) => {
  console.error("utility-demo failed:", err);
  process.exit(1);
});
