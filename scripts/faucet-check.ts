/**
 * Cortex — pre-flight check before any Braga write.
 *
 * Run: bun run faucet-check
 *
 * Verifies:
 *   1. SESSION_KEY_PRIVATE_KEY is set and valid
 *   2. The session-key EOA has non-zero GLM balance on Braga
 *   3. The Arkiv precompile is responding (chain is live)
 *   4. Block timing is sane (we can compute extend math)
 *
 * If balance is zero, prints the faucet URL and exits non-zero so CI catches it.
 */

import { formatEther } from "viem";
import { getPublicClient, getSessionKeyAddress, getWalletClient } from "../src/lib/arkiv-client";
import { BRAGA } from "../src/constants";

async function main() {
  console.log("\n=== Cortex faucet-check ===\n");
  console.log("Network    :", "Braga", `(chainId ${BRAGA.chainId})`);
  console.log("RPC        :", BRAGA.httpRpc);
  console.log("Explorer   :", BRAGA.explorer);

  // 1. Session key loadable
  let sessionKeyAddr: `0x${string}`;
  try {
    getWalletClient(); // throws if SESSION_KEY_PRIVATE_KEY missing/malformed
    sessionKeyAddr = getSessionKeyAddress();
  } catch (err) {
    console.error("\n❌ Wallet bootstrap failed:");
    console.error("   ", err instanceof Error ? err.message : err);
    process.exit(1);
  }
  console.log("Session EOA:", sessionKeyAddr);

  const publicClient = getPublicClient();

  // 2. Balance
  const balance = await publicClient.getBalance({ address: sessionKeyAddr });
  const glm = formatEther(balance);
  console.log("Balance    :", `${glm} GLM`);

  if (balance === 0n) {
    console.error("\n❌ Session key has zero balance.");
    console.error("   Top up via:", BRAGA.faucet);
    console.error("   Address    :", sessionKeyAddr);
    process.exit(2);
  }
  if (balance < 10_000_000_000_000_000n /* 0.01 GLM */) {
    console.warn("\n⚠️  Balance is low. A few entity writes may exhaust it.");
    console.warn("   Top up via:", BRAGA.faucet);
  }

  // 3. Chain liveness via entity count
  const entityCount = await publicClient.getEntityCount();
  console.log("Live entities (network-wide):", entityCount);

  // 4. Block timing — confirms getBlockTiming is functional (we depend on it)
  const timing = await publicClient.getBlockTiming();
  console.log("Block      :", `#${timing.currentBlock} @ ${new Date(timing.currentBlockTime * 1000).toISOString()}`);
  console.log("Block time :", `${timing.blockDuration}s`);

  console.log("\n✅ Pre-flight passed. You can write to Braga.\n");
}

main().catch((err) => {
  console.error("\nfaucet-check crashed:", err);
  process.exit(1);
});
