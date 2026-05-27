/**
 * Cortex — seed demo memories (CLI wrapper).
 *
 * Thin wrapper around src/agent/seed-memories.ts. The actual observations +
 * embed/seal/create logic lives there so the dashboard's POST /api/seed-memories
 * endpoint can call the same code.
 *
 * Run:  bun run seed   (before  bun run dashboard, in env-identity mode)
 */

import { BRAGA } from "../src/constants";
import { seedDemoMemories, SEED_OBSERVATIONS } from "../src/agent/seed-memories";

async function main(): Promise<void> {
  console.log("\n=== Cortex seed-memories ===\n");
  console.log(`Embedding + packing ${SEED_OBSERVATIONS.length} observations…`);
  console.log("Sealing + writing batch to Braga (wallet-encrypted at rest)…");

  const result = await seedDemoMemories();
  console.log(`\n✅ Seeded ${result.count} sealed memories in 1 tx`);
  console.log(`   tx ${BRAGA.explorer}tx/${result.txHash}`);
  for (let i = 0; i < result.entityKeys.length; i++) {
    console.log(`   ${result.markers[i]!.padEnd(20)} ${result.entityKeys[i]}`);
  }
  console.log(
    "\nThe autonomous loop will now find + cite these; citations extend their lease.",
  );
}

main().catch((err) => {
  console.error("seed-memories failed:", err);
  process.exit(1);
});
