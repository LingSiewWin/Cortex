/**
 * Cortex — scripted end-to-end demo flow.
 *
 * Run: bun run demo-flow
 *
 * What it does (in order, against Braga):
 *   1. Pre-flight: validates SESSION_KEY_PRIVATE_KEY + USER_PRIMARY_ADDRESS,
 *      checks balance, confirms chain is live.
 *   2. Creates THREE observation entities with realistic agent-flavoured payloads.
 *      Each is RaBitQ-compressed if OPENAI_API_KEY is set, else falls back to a
 *      synthetic 1536-d unit vector so the demo works offline.
 *   3. Runs a recall() against the just-written set, picks the top 2 as citations.
 *   4. Fires act() — exercises the accumulative-extend math and the citation
 *      validator. Prints the resulting tx hashes + explorer links.
 *   5. Prints a summary table so a judge can verify on the explorer.
 *
 * This is the script behind the "live demo" in DEMO.md. The numbers it prints
 * are the same ones the dashboard shows.
 *
 * Exit codes:
 *   0 — full flow completed, citations applied, tx hashes printed
 *   1 — pre-flight failed (no key, no balance, RPC dead)
 *   2 — Arkiv writes failed
 *   3 — act() found no valid citations (recall returned empty)
 */

import { jsonToPayload, ExpirationTime } from "@arkiv-network/sdk/utils";
import type { Hex } from "@arkiv-network/sdk";
import { formatEther } from "viem";
import { singleCreate, batchCreate } from "../src/lib/batch-writer";
import {
  cortexQuery,
  getPublicClient,
  getSessionKeyAddress,
  getWalletClient,
} from "../src/lib/arkiv-client";
import { rabitqEncode, packCode } from "../src/compression/rabitq";
import { embedText } from "../src/compression/embeddings";
import { recall } from "../src/darwinian/recall";
import { act } from "../src/darwinian/citation";
import { initMirrorDb } from "../src/mirror/db";
import { BRAGA, ENTITY_TYPE } from "../src/constants";

// ---------------------------------------------------------------------------
// Demo payloads — three observation seeds an agent might plausibly emit.
// ---------------------------------------------------------------------------

interface DemoObservation {
  marker: string;
  note: string;
  /** Natural-language text fed to the embedder for RaBitQ packing. */
  observationText: string;
}

const DEMO_OBSERVATIONS: DemoObservation[] = [
  {
    marker: "obs-anti-rug",
    note: "Anti-rug heuristic seed",
    observationText:
      "Token contracts with unverified source and >95% supply held by the deployer wallet are 4.3x more likely to rug pull within 48 hours of LP creation.",
  },
  {
    marker: "obs-prefers-tea",
    note: "User preference seed",
    observationText:
      "User prefers tea over coffee in the afternoon. Mentioned twice this week in passing during coding sessions.",
  },
  {
    marker: "obs-noise",
    note: "Decoy noise seed",
    observationText:
      "The cat walked across the keyboard at 14:22 and typed 'kkkkkk' into the chat. Probably not load-bearing.",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function explorerTx(txHash: string): string {
  return `${BRAGA.explorer}tx/${txHash}`;
}

function explorerEntity(entityKey: string): string {
  return `${BRAGA.explorer}entities/${entityKey}`;
}

/**
 * Embed text → RaBitQ pack. Falls back to a deterministic synthetic vector if
 * OPENAI_API_KEY is missing so the demo can be exercised offline.
 */
async function embedOrSynth(text: string): Promise<Uint8Array> {
  let vec: Float32Array;
  if (process.env["OPENAI_API_KEY"]) {
    vec = await embedText(text);
  } else {
    // Deterministic synthetic vector — Mulberry32 seeded by text length so the
    // canary still produces stable RaBitQ codes across reruns.
    const D = 1536;
    vec = new Float32Array(D);
    let s = text.length * 2654435761;
    let sum = 0;
    for (let i = 0; i < D; i++) {
      s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      vec[i] = r - 0.5;
      sum += vec[i]! * vec[i]!;
    }
    const norm = Math.sqrt(sum) || 1;
    for (let i = 0; i < D; i++) vec[i] = vec[i]! / norm;
  }
  const code = rabitqEncode(vec);
  return packCode(code);
}

function fmtTxLine(label: string, txHash: string): string {
  return `   ${label.padEnd(28)} ${txHash}\n   ${" ".repeat(28)} → ${explorerTx(txHash)}`;
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("\n=== Cortex demo flow ===\n");

  // -- Step 1: pre-flight -------------------------------------------------

  const userPrimary = process.env["USER_PRIMARY_ADDRESS"];
  if (!userPrimary || !/^0x[0-9a-fA-F]{40}$/.test(userPrimary)) {
    console.error(
      "❌ USER_PRIMARY_ADDRESS is missing or malformed. Set it in .env to a 0x-prefixed EOA address.",
    );
    process.exit(1);
  }

  let sessionKey: Hex;
  try {
    getWalletClient();
    sessionKey = getSessionKeyAddress();
  } catch (err) {
    console.error("❌ Wallet bootstrap failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  const publicClient = getPublicClient();
  const balance = await publicClient.getBalance({ address: sessionKey });
  console.log("Network    :", "Braga", `(chainId ${BRAGA.chainId})`);
  console.log("Session key:", sessionKey);
  console.log("User EOA   :", userPrimary);
  console.log("Balance    :", `${formatEther(balance)} GLM`);
  if (balance === 0n) {
    console.error("\n❌ Session key balance is zero. Top up via", BRAGA.faucet);
    process.exit(1);
  }

  // Warm the mirror so act() can write its citation_counts rows.
  await initMirrorDb();

  // -- Step 2: create three observations ---------------------------------

  console.log("\n[1/4] Creating 3 observation entities…\n");
  const creates = [];
  for (const obs of DEMO_OBSERVATIONS) {
    const packed = await embedOrSynth(obs.observationText);
    creates.push({
      payload: packed,
      contentType: "application/octet-stream",
      attributes: [
        { key: "entityType", value: ENTITY_TYPE.OBSERVATION },
        { key: "marker", value: obs.marker },
        { key: "note", value: obs.note },
        { key: "demoRun", value: Date.now() },
      ],
      expiresInSeconds: ExpirationTime.fromMinutes(60),
    });
  }

  let createResult;
  try {
    createResult = await batchCreate(creates);
  } catch (err) {
    console.error(
      "\n❌ batchCreate failed:",
      err instanceof Error ? err.message : err,
    );
    process.exit(2);
  }

  console.log(fmtTxLine("create batch tx", createResult.txHash));
  for (let i = 0; i < createResult.entityKeys.length; i++) {
    const key = createResult.entityKeys[i]!;
    const obs = DEMO_OBSERVATIONS[i]!;
    console.log(`     #${i + 1}  ${key}  (${obs.marker})`);
    console.log(`         → ${explorerEntity(key)}`);
  }

  // -- Step 3: recall ----------------------------------------------------

  console.log("\n[2/4] Recalling memories about rug-pull risk…\n");
  let hits;
  try {
    hits = await recall({
      query: "is this token launch likely to rug? what's our policy?",
      k: 3,
      entityType: "observation",
    });
  } catch (err) {
    console.error(
      "❌ recall failed (likely OPENAI_API_KEY missing for live embedding):",
      err instanceof Error ? err.message : err,
    );
    process.exit(2);
  }

  if (hits.length === 0) {
    console.error("❌ recall returned zero candidates. Cannot fire act().");
    process.exit(3);
  }

  console.log(`   recall returned ${hits.length} candidate(s):`);
  for (const h of hits) {
    const marker = h.attributes.find((a) => a.key === "marker")?.value ?? "?";
    console.log(
      `     ${h.entityKey.slice(0, 16)}…  score=${h.score.toFixed(4)}  marker=${marker}`,
    );
  }

  // -- Step 4: act with citations ----------------------------------------

  console.log("\n[3/4] Firing act() — accumulative extend on the top 2 cited memories…\n");
  const citations = hits.slice(0, Math.min(2, hits.length)).map((h) => h.entityKey);

  let actResult;
  try {
    actResult = await act({
      action: "Declined to buy TokenX — cited anti-rug heuristic + user policy.",
      citations,
      userPrimaryEOA: userPrimary as Hex,
      sessionId: `demo-flow-${Date.now()}`,
    });
  } catch (err) {
    console.error(
      "❌ act failed:",
      err instanceof Error ? err.message : err,
    );
    process.exit(2);
  }

  console.log(`   action      : ${actResult.action}`);
  console.log(`   citations   : ${actResult.citations.length} valid`);
  console.log(`   extended    : ${actResult.extendedKeys.length} memorie(s)`);
  console.log(`   promoted    : ${actResult.promotedKeys.length}`);

  for (let i = 0; i < actResult.txHashes.length; i++) {
    console.log(fmtTxLine(`act tx #${i + 1}`, actResult.txHashes[i]!));
  }

  // -- Summary -----------------------------------------------------------

  console.log("\n[4/4] Summary\n");
  console.log("Created entities:");
  for (const key of createResult.entityKeys) {
    console.log(`   ${key}`);
  }
  console.log("\nReinforcement tx hashes:");
  for (const tx of actResult.txHashes) {
    console.log(`   ${tx}`);
  }

  console.log(
    "\n✅ Demo flow complete. Open the explorer to verify on-chain state:",
  );
  console.log("  ", BRAGA.explorer);
  console.log(
    "\nNext: run `bun run dashboard` and watch the cited memories' health bars grow.\n",
  );
}

main().catch((err) => {
  console.error("\ndemo-flow crashed:", err);
  process.exit(99);
});
