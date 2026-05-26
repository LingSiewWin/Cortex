/**
 * Cortex — seed demo memories (Phase 16).
 *
 * Writes 8 observation memories whose text answers the autonomous loop's
 * DEFAULT_QUERY_POOL, so recall reliably returns relevant hits and the loop
 * produces a full cascade (memory.cited → mmr.appended → anchor.committed).
 *
 * Working-tier observations start at a 60-minute lease; once the autonomous
 * loop begins citing them, accumulative extend keeps them alive — they
 * self-sustain for as long as the demo runs.
 *
 * Run:  bun run seed   (before  bun run dashboard)
 */

import { createMemories } from "../src/lib/batch-writer";
import { embedAndQuantize } from "../src/compression/embeddings";
import { initMirrorDb } from "../src/mirror/db";
import { ENTITY_TYPE, BRAGA } from "../src/constants";
import { ExpirationTime } from "@arkiv-network/sdk/utils";

/** Each answers one DEFAULT_QUERY_POOL query so recall scores it highly. */
const SEED_OBSERVATIONS: { marker: string; text: string }[] = [
  {
    marker: "reentrancy",
    text: "Solidity reentrancy is mitigated by the checks-effects-interactions pattern and reentrancy guard modifiers; never make external calls before updating state.",
  },
  {
    marker: "compression",
    text: "RaBitQ 1-bit rotational quantization compresses a 1536-dimension float32 embedding to 198 bytes (about 31x) with an unbiased inner-product estimator for retrieval.",
  },
  {
    marker: "mmr",
    text: "MMR proof verification walks the leaf hash up its sibling hashes to its peak, then bags all peaks right-to-left and checks the result equals the claimed root.",
  },
  {
    marker: "erc-stack",
    text: "Cortex composes EIP-712 typed sessions, ERC-1271 and ERC-6492 smart-wallet signatures, ERC-4361 SIWE login, ERC-5792 capability probing, and ERC-5169 scriptURI.",
  },
  {
    marker: "accumulative-extend",
    text: "Accumulative extend preserves remaining lease time plus a reinforcement delta, so frequently cited memories grow their lifespan instead of resetting — LTP-faithful, not REPLACE-naive.",
  },
  {
    marker: "ownership",
    text: "The session key is the immutable creator for tamper-proof attribution, while the user's primary EOA is the mutable owner that controls extend, update, and delete.",
  },
  {
    marker: "synaptic-market",
    text: "The Synaptic Market lists distilled rules with a public GLM price and a sealed payload; buyers pay and the seller's relayer publishes a decryption grant entity.",
  },
  {
    marker: "darwinian",
    text: "The Darwinian primitive is citation-driven reinforcement: every act() that cites a memory extends its on-chain lease, so useful thoughts survive and unused ones evict for free.",
  },
];

async function main(): Promise<void> {
  console.log("\n=== Cortex seed-memories ===\n");
  await initMirrorDb();

  console.log(`Embedding + packing ${SEED_OBSERVATIONS.length} observations…`);
  const creates = [];
  for (const obs of SEED_OBSERVATIONS) {
    const { bytes } = await embedAndQuantize(obs.text);
    creates.push({
      payload: bytes,
      contentType: "application/octet-stream",
      attributes: [
        { key: "entityType", value: ENTITY_TYPE.OBSERVATION },
        { key: "marker", value: obs.marker },
        { key: "seed", value: Date.now() },
      ],
      expiresInSeconds: ExpirationTime.fromMinutes(60),
    });
  }

  console.log("Sealing + writing batch to Braga (wallet-encrypted at rest)…");
  const result = await createMemories(creates);
  console.log(`\n✅ Seeded ${result.entityKeys.length} sealed memories in 1 tx`);
  console.log(`   tx ${BRAGA.explorer}tx/${result.txHash}`);
  for (let i = 0; i < result.entityKeys.length; i++) {
    console.log(`   ${SEED_OBSERVATIONS[i]!.marker.padEnd(20)} ${result.entityKeys[i]}`);
  }
  console.log(
    "\nThe autonomous loop will now find + cite these; citations extend their lease.",
  );
}

main().catch((err) => {
  console.error("seed-memories failed:", err);
  process.exit(1);
});
