/**
 * Cortex — encryption-at-rest e2e on real Braga (Goal 0d).
 *
 * Proves the sovereignty keystone end-to-end:
 *   1. createMemory seals a RaBitQ observation with the wallet-derived key and
 *      writes CIPHERTEXT to Arkiv.
 *   2. The real mirror daemon re-syncs that ciphertext from the public RPC.
 *   3. recall WITH the wallet key opens it in RAM and returns the memory.
 *   4. recall WITHOUT the wallet key (negative control) cannot open it → MISS,
 *      no crash. The memory is present on-chain but unreadable.
 *
 * Run:  CORTEX_USER_PRIVATE_KEY=0x<primary-eoa-key> bun scripts/sealed-e2e.ts
 *       (the primary key only signs the local key-derivation message — no funds
 *        needed; the session key pays for the write.)
 */

import { ExpirationTime } from "@arkiv-network/sdk/utils";
import { startMirrorDaemon } from "../src/mirror/daemon";
import { getPublicClient } from "../src/lib/arkiv-client";
import { embedAndQuantize } from "../src/compression/embeddings";
import { createMemory } from "../src/lib/batch-writer";
import { recall, _resetLastRecallIds } from "../src/darwinian/recall";
import { getPayloadKey, _resetPayloadKey, requirePayloadKey } from "../src/lib/payload-key";
import { getMirroredEntity } from "../src/mirror/replay";
import { ENTITY_TYPE, BRAGA, SEALED_CONTENT_TYPE } from "../src/constants";

const TEXT = "Always verify a contract is audited and liquidity is locked before integrating it.";
const QUERY = "should I integrate this unaudited contract?";
const RABITQ_PACK_SIZE = 198;

async function waitForMirror(entityKey: `0x${string}`, timeoutMs: number): Promise<Uint8Array> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const e = await getMirroredEntity(entityKey);
    if (e?.payload && e.payload.byteLength > 0) return e.payload;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`mirror did not sync ${entityKey} within ${timeoutMs}ms`);
}

async function main(): Promise<void> {
  console.log("\n=== Cortex sealed-memory e2e (real Braga) ===\n");

  // Fail fast if no sealing key — createMemory would throw anyway.
  await requirePayloadKey();

  const pc = getPublicClient();
  const timing = await pc.getBlockTiming();
  console.log(`[setup] starting mirror daemon at head block ${timing.currentBlock}`);
  const daemon = await startMirrorDaemon({ fromBlock: timing.currentBlock, pollingIntervalMs: 1000 });

  try {
    console.log("[1/4] sealing + writing observation (ciphertext to Arkiv)…");
    const { bytes } = await embedAndQuantize(TEXT);
    const created = await createMemory({
      payload: bytes,
      contentType: "application/octet-stream", // replaced by SEALED_CONTENT_TYPE
      attributes: [
        { key: "entityType", value: ENTITY_TYPE.OBSERVATION },
        { key: "marker", value: "sealed-e2e" },
        { key: "ts", value: Date.now() },
      ],
      expiresInSeconds: ExpirationTime.fromMinutes(60),
    });
    console.log(`        entity ${created.entityKey}`);
    console.log(`        ${BRAGA.explorer}tx/${created.txHash}`);

    console.log("[2/4] waiting for the daemon to re-sync ciphertext from chain…");
    const mirroredPayload = await waitForMirror(created.entityKey, 60_000);
    const mirrored = await getMirroredEntity(created.entityKey);
    const isCiphertext =
      mirrored?.contentType === SEALED_CONTENT_TYPE && mirroredPayload.byteLength !== RABITQ_PACK_SIZE;
    console.log(
      `        mirror holds ${mirroredPayload.byteLength}B, contentType=${mirrored?.contentType} ` +
        `→ ${isCiphertext ? "CIPHERTEXT ✅" : "NOT sealed ❌"}`,
    );
    if (!isCiphertext) throw new Error("mirror payload is not sealed ciphertext");

    console.log("[3/4] recall WITH wallet key…");
    _resetLastRecallIds();
    const withKey = await recall({ query: QUERY, k: 5 });
    const hitWith = withKey.find((h) => h.entityKey === created.entityKey);
    console.log(
      `        ${hitWith ? `HIT ✅ (score ${hitWith.score.toFixed(4)})` : "MISS ❌"} ` +
        `among ${withKey.length} hits`,
    );
    if (!hitWith) throw new Error("recall with key failed to return the sealed memory");

    console.log("[4/4] negative control — recall WITHOUT wallet key…");
    delete process.env.CORTEX_USER_PRIVATE_KEY;
    delete process.env.CORTEX_USER_SIGNATURE;
    _resetPayloadKey();
    if ((await getPayloadKey()) !== null) throw new Error("expected null key after clearing wallet");
    _resetLastRecallIds();
    const noKey = await recall({ query: QUERY, k: 5 });
    const hitNo = noKey.find((h) => h.entityKey === created.entityKey);
    console.log(`        ${hitNo ? "HIT ❌ (should be unreadable)" : "MISS ✅ (unreadable without wallet)"}`);
    if (hitNo) throw new Error("negative control failed: sealed memory readable without the key");

    console.log(
      "\n✅ Sovereignty keystone proven on Braga: the memory is ciphertext on-chain and in the " +
        "mirror; only the wallet key unseals it at recall. Without the wallet it is present but unreadable.",
    );
    console.log(`   tx: ${BRAGA.explorer}tx/${created.txHash}`);
  } finally {
    daemon.stop();
  }
}

main().catch((err) => {
  console.error("\nsealed-e2e failed:", err);
  process.exit(1);
});
