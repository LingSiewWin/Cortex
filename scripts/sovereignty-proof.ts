/**
 * Cortex — Proof of Sovereignty (Goal 1) on real Braga.
 *
 * The hardest trilemma corner: sovereignty under OPERATOR DEATH. We show that a
 * memory survives the backend being destroyed, recoverable on a clean machine
 * with ONLY the user's wallet — because the encrypted memory lives on the public
 * Arkiv chain (Phase 18 keystone) and the key derives from the wallet alone.
 *
 * Sequence (each "fresh machine" is a real separate subprocess sharing only a
 * temp mirror path + the wallet env — no shared in-process state):
 *   0. ALIVE:           seal + write a memory to Arkiv (the agent, while running).
 *   1. OPERATOR DEATH:  wipe the entire local mirror (simulate the backend dying
 *                       and a brand-new machine with an empty disk).
 *   2. COLD REBUILD + WALLET:  backfill the mirror from the PUBLIC Arkiv RPC, then
 *                       recall WITH the wallet → the memory is back. Survived.
 *   3. NEGATIVE CONTROL: wipe again, rebuild, recall WITHOUT the wallet → MISS.
 *                       Present on-chain, unreadable without the wallet.
 *
 * Run:  CORTEX_USER_PRIVATE_KEY=0x<primary-eoa-key> bun scripts/sovereignty-proof.ts
 *       (primary key only signs the local derivation message — no funds needed.)
 */

import { $ } from "bun";
import { unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExpirationTime } from "@arkiv-network/sdk/utils";
import { embedAndQuantize } from "../src/compression/embeddings";
import { createMemory } from "../src/lib/batch-writer";
import { requirePayloadKey } from "../src/lib/payload-key";
import { ENTITY_TYPE, BRAGA } from "../src/constants";

const TEXT = "Bridge withdrawals on this chain take 7 days; never promise users instant exits.";
const QUERY = "how long do bridge withdrawals take here?";
const MIRROR = join(tmpdir(), `cortex-sovereignty-${Date.now()}.sqlite`);
const WALLET = process.env.CORTEX_USER_PRIVATE_KEY ?? "";

function wipeMirror(): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const f = MIRROR + suffix;
    if (existsSync(f)) unlinkSync(f);
  }
}

/** Env for a "fresh machine" subprocess. `withWallet` decides if the key is present. */
function freshEnv(withWallet: boolean): Record<string, string> {
  const base: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CORTEX_MIRROR_PATH: MIRROR,
  };
  delete base.CORTEX_USER_SIGNATURE;
  if (withWallet) base.CORTEX_USER_PRIVATE_KEY = WALLET;
  else delete base.CORTEX_USER_PRIVATE_KEY;
  return base;
}

async function rebuildFromChain(withWallet: boolean): Promise<void> {
  // The mirror is empty — rebuild it purely from the public Arkiv event stream.
  // backfill needs NO wallet (it stores ciphertext); the wallet only matters at recall.
  await $`bun scripts/backfill.ts`.env({ ...freshEnv(withWallet), BACKFILL_BLOCKS: "6000" }).quiet();
}

async function probe(withWallet: boolean, entity: string): Promise<boolean> {
  const res = await $`bun scripts/_recall-probe.ts`
    .env({ ...freshEnv(withWallet), PROBE_QUERY: QUERY, PROBE_ENTITY: entity })
    .nothrow()
    .quiet();
  process.stdout.write("        " + res.stdout.toString().trim() + "\n");
  return res.exitCode === 0;
}

async function main(): Promise<void> {
  console.log("\n=== Cortex — Proof of Sovereignty (real Braga) ===\n");
  console.log(`    temp mirror: ${MIRROR}`);

  if (!WALLET) {
    console.error("\n❌ set CORTEX_USER_PRIVATE_KEY (the user's primary wallet) to run this proof.");
    process.exit(2);
  }
  await requirePayloadKey();

  // 0. ALIVE — the agent seals + writes a memory while the backend is running.
  console.log("\n[0] ALIVE: sealing + writing a memory to Arkiv…");
  const { bytes } = await embedAndQuantize(TEXT);
  const created = await createMemory({
    payload: bytes,
    contentType: "application/octet-stream",
    attributes: [
      { key: "entityType", value: ENTITY_TYPE.OBSERVATION },
      { key: "marker", value: "sovereignty-proof" },
      { key: "ts", value: Date.now() },
    ],
    expiresInSeconds: ExpirationTime.fromMinutes(60),
  });
  console.log(`    entity ${created.entityKey}`);
  console.log(`    ${BRAGA.explorer}tx/${created.txHash}`);
  // Give Braga a few seconds to index the EntityCreated log for getLogs.
  await new Promise((r) => setTimeout(r, 6000));

  // 1. OPERATOR DEATH — destroy the entire local mirror.
  console.log("\n[1] OPERATOR DEATH: wiping the entire local mirror (clean machine)…");
  wipeMirror();
  console.log(`    mirror exists after wipe: ${existsSync(MIRROR)}`);

  // 2. COLD REBUILD + WALLET — rebuild from chain, recall with only the wallet.
  console.log("\n[2] COLD REBUILD: backfilling the mirror from the public Arkiv RPC…");
  await rebuildFromChain(true);
  console.log("    recall WITH only the wallet:");
  const survived = await probe(true, created.entityKey);
  if (!survived) throw new Error("memory did NOT survive operator death — sovereignty proof failed");

  // 3. NEGATIVE CONTROL — fresh machine, no wallet.
  console.log("\n[3] NEGATIVE CONTROL: wipe again, rebuild, recall WITHOUT the wallet…");
  wipeMirror();
  await rebuildFromChain(false);
  console.log("    recall WITHOUT the wallet:");
  const leaked = await probe(false, created.entityKey);
  if (leaked) throw new Error("negative control failed: memory readable without the wallet");

  wipeMirror();
  console.log(
    "\n✅ Sovereignty proven on Braga: the backend died and the mirror was destroyed, yet the memory " +
      "rebuilt from the public chain and decrypted with ONLY the user's wallet. Without the wallet it " +
      "is present but unreadable.",
  );
  console.log(`   tx: ${BRAGA.explorer}tx/${created.txHash}`);
}

main().catch((err) => {
  wipeMirror();
  console.error("\nsovereignty-proof failed:", err);
  process.exit(1);
});
