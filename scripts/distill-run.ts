/**
 * Cortex — RULE-tier proof (Phase 16 integration).
 *
 * Proves the working → episodic → semantic consolidation end-to-end on Braga:
 *   1. create an observation O
 *   2. cite O repeatedly across DISTINCT sessions until it crosses the semantic
 *      threshold (count ≥ promoteToSemantic across ≥ distinctSessionsForSemantic)
 *   3. run distillIfReady → writes a RULE entity on Braga + transfers ownership
 *
 * The single-session autonomous loop can't trigger semantic promotion (it needs
 * ≥3 distinct sessions by design — semantic = cross-session consolidation). This
 * script supplies those sessions, exercising the tier the loop wires up.
 *
 * The LLM distillation step uses a real Anthropic call when ANTHROPIC_API_KEY is
 * set; otherwise it falls back to an offline deterministic synthesizer (same
 * pattern as cite-flow's synthetic-embedding fallback) so the ON-CHAIN mechanism
 * — threshold → RULE entity → ownership transfer — is provable without the key.
 *
 * Run:  bun run distill-run
 */

import { embedAndQuantize } from "../src/compression/embeddings";
import { singleCreate } from "../src/lib/batch-writer";
import { recall } from "../src/darwinian/recall";
import { act, getCitationStats } from "../src/darwinian/citation";
import { distillIfReady } from "../src/darwinian/distill";
import { getUserPrimaryEOA } from "../src/lib/arkiv-client";
import { getPayloadKey } from "../src/lib/payload-key";
import { initMirrorDb } from "../src/mirror/db";
import { hydrateEntityFromChain } from "../src/mirror/hydrate-one";
import { ENTITY_TYPE, BRAGA, REINFORCEMENT } from "../src/constants";
import { ExpirationTime } from "@arkiv-network/sdk/utils";
import type { Hex } from "@arkiv-network/sdk";

const OBS_TEXT =
  "When a token launch shows a freshly funded deployer, locked liquidity under 30 days, and no audit, treat it as high rug-pull risk and decline.";
const QUERY = "is this token launch likely to rug?";

function explorerTx(h: string): string {
  return `${BRAGA.explorer}tx/${h}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Recall until the fresh observation is in the candidate set (mirror / index lag). */
async function recallIncludesObs(obsKey: Hex, attempts = 12): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const hits = await recall({ query: QUERY, k: 10 });
    if (hits.some((h) => h.entityKey === obsKey)) return;
    await sleep(1500);
  }
  throw new Error(
    `Observation ${obsKey.slice(0, 10)}… not returned by recall after ${attempts} tries. ` +
      `Check OPENROUTER/COHERE embedding key and mirror hydration.`,
  );
}

async function main(): Promise<void> {
  console.log("\n=== Cortex distill-run (RULE tier, real Braga) ===\n");
  await initMirrorDb();
  const userEOA = getUserPrimaryEOA();

  const payloadKey = await getPayloadKey();
  if (!payloadKey) {
    console.error(
      "❌ Missing encryption key. Run:\n" +
        "   CORTEX_USER_PRIVATE_KEY=0x<primary> bun scripts/derive-user-signature.ts\n" +
        "   then add CORTEX_USER_SIGNATURE=0x… to .env\n",
    );
    process.exit(1);
  }

  // 1. Create the observation.
  console.log("[1] Creating observation…");
  const { bytes } = await embedAndQuantize(OBS_TEXT);
  const obs = await singleCreate({
    payload: bytes,
    contentType: "application/octet-stream",
    attributes: [
      { key: "entityType", value: ENTITY_TYPE.OBSERVATION },
      { key: "marker", value: "rug-policy" },
      { key: "distillRun", value: Date.now() },
    ],
    expiresInSeconds: ExpirationTime.fromMinutes(60),
  });
  console.log(`    ${obs.entityKey}`);
  console.log(`    ${explorerTx(obs.txHash)}`);

  const hydrated = await hydrateEntityFromChain(obs.entityKey);
  console.log(`    mirror hydrate: ${hydrated.status}\n`);

  // 2. Cite across distinct sessions until semantic-ready.
  //    promoteToSemantic citations across distinctSessionsForSemantic sessions.
  const sessions = ["sess-a", "sess-b", "sess-c"];
  const citeRounds = Math.max(
    REINFORCEMENT.promoteToSemantic,
    REINFORCEMENT.distinctSessionsForSemantic,
  );
  console.log(
    `[2] Citing across ${sessions.length} sessions × ${citeRounds} rounds (thresholds: ${REINFORCEMENT.promoteToSemantic} cites / ${REINFORCEMENT.distinctSessionsForSemantic} sessions)…`,
  );
  await recallIncludesObs(obs.entityKey);

  for (let i = 0; i < citeRounds; i++) {
    const sessionId = sessions[i % sessions.length]!;
    await recall({ query: QUERY, k: 10 });
    const result = await act({
      action: `evaluate launch (round ${i + 1})`,
      citations: [obs.entityKey],
      userPrimaryEOA: userEOA,
      sessionId,
    });
    console.log(
      `    round ${i + 1} [${sessionId}] cited ${obs.entityKey.slice(0, 10)}… promoted=${result.promotedKeys.length > 0}`,
    );
  }

  // 3. Distill. Offline synthesizer when no Anthropic key (mechanism still real).
  const hasKey = Boolean(process.env["ANTHROPIC_API_KEY"]);
  console.log(
    `\n[3] Running distillIfReady (${hasKey ? "real Anthropic LLM" : "offline synthesizer — no ANTHROPIC_API_KEY"})…`,
  );
  const distilled = await distillIfReady({
    userPrimaryEOA: userEOA,
    _deps: {
      // Only distill the observation we just cited — skip stale mirror rows.
      listReady: async () => {
        const stats = await getCitationStats(obs.entityKey);
        return stats?.promotedTo === "rule" ? [stats] : [];
      },
      ...(hasKey
        ? {}
        : {
            callLlm: async (prompt: string) => {
              const firstSnippet =
                prompt.split("[1]")[1]?.split("\n")[0]?.trim() ?? OBS_TEXT;
              return `Rule: ${firstSnippet.slice(0, 200)}`;
            },
          }),
    },
  });

  if (!distilled) {
    console.error(
      "\n❌ distillIfReady returned null — the memory did not reach the semantic threshold.",
    );
    console.error(
      `   (Check REINFORCEMENT thresholds + citation stats for ${obs.entityKey.slice(0, 10)}….)`,
    );
    process.exit(3);
  }

  console.log(`\n✅ RULE distilled + written on Braga:`);
  console.log(`   text: ${distilled.ruleText}`);
  console.log(`   from ${distilled.sourceEpisodeKeys.length} source episode(s)`);
  console.log(
    "\nThe working → episodic → semantic tier path is reachable end-to-end.",
  );
}

main().catch((err) => {
  console.error("distill-run failed:", err);
  process.exit(1);
});
