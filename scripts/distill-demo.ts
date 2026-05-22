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
 * script supplies those sessions, demonstrating the tier the loop wires up.
 *
 * The LLM distillation step uses a real Anthropic call when ANTHROPIC_API_KEY is
 * set; otherwise it falls back to an offline deterministic synthesizer (same
 * pattern as demo-flow's synthetic-embedding fallback) so the ON-CHAIN mechanism
 * — threshold → RULE entity → ownership transfer — is provable without the key.
 *
 * Run:  bun run distill-demo
 */

import { embedAndQuantize } from "../src/compression/embeddings";
import { singleCreate } from "../src/lib/batch-writer";
import { recall } from "../src/darwinian/recall";
import { act } from "../src/darwinian/citation";
import { distillIfReady } from "../src/darwinian/distill";
import { getUserPrimaryEOA } from "../src/lib/arkiv-client";
import { initMirrorDb } from "../src/mirror/db";
import { ENTITY_TYPE, BRAGA, REINFORCEMENT } from "../src/constants";
import { ExpirationTime } from "@arkiv-network/sdk/utils";

const OBS_TEXT =
  "When a token launch shows a freshly funded deployer, locked liquidity under 30 days, and no audit, treat it as high rug-pull risk and decline.";
const QUERY = "is this token launch likely to rug?";

function explorerTx(h: string): string {
  return `${BRAGA.explorer}tx/${h}`;
}

async function main(): Promise<void> {
  console.log("\n=== Cortex distill-demo (RULE tier, real Braga) ===\n");
  await initMirrorDb();
  const userEOA = getUserPrimaryEOA();

  // 1. Create the observation.
  console.log("[1] Creating observation…");
  const { bytes } = await embedAndQuantize(OBS_TEXT);
  const obs = await singleCreate({
    payload: bytes,
    contentType: "application/octet-stream",
    attributes: [
      { key: "entityType", value: ENTITY_TYPE.OBSERVATION },
      { key: "marker", value: "rug-policy" },
      { key: "distillDemo", value: Date.now() },
    ],
    expiresInSeconds: ExpirationTime.fromMinutes(60),
  });
  console.log(`    ${obs.entityKey}`);
  console.log(`    ${explorerTx(obs.txHash)}\n`);

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
  for (let i = 0; i < citeRounds; i++) {
    const sessionId = sessions[i % sessions.length]!;
    // recall must run first so the citation validates against the last recall.
    const hits = await recall({ query: QUERY, k: 5 });
    const target = hits.find((h) => h.entityKey === obs.entityKey) ?? hits[0];
    if (!target) {
      console.error("    recall returned no hits — aborting");
      process.exit(2);
    }
    const result = await act({
      action: `evaluate launch (round ${i + 1})`,
      citations: [target.entityKey],
      userPrimaryEOA: userEOA,
      sessionId,
    });
    console.log(
      `    round ${i + 1} [${sessionId}] cited ${target.entityKey.slice(0, 10)}… promoted=${result.promotedKeys.length > 0}`,
    );
  }

  // 3. Distill. Offline synthesizer when no Anthropic key (mechanism still real).
  const hasKey = Boolean(process.env["ANTHROPIC_API_KEY"]);
  console.log(
    `\n[3] Running distillIfReady (${hasKey ? "real Anthropic LLM" : "offline synthesizer — no ANTHROPIC_API_KEY"})…`,
  );
  const distilled = await distillIfReady({
    userPrimaryEOA: userEOA,
    ...(hasKey
      ? {}
      : {
          _deps: {
            callLlm: async (prompt: string) => {
              // Deterministic offline distillation: extract the policy sentence.
              const firstSnippet =
                prompt.split("[1]")[1]?.split("\n")[0]?.trim() ?? OBS_TEXT;
              return `Rule: ${firstSnippet.slice(0, 200)}`;
            },
          },
        }),
  });

  if (!distilled) {
    console.error(
      "\n❌ distillIfReady returned null — the memory did not reach the semantic threshold.",
    );
    console.error(
      "   (Check REINFORCEMENT thresholds + that recall returned the seeded observation.)",
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
  console.error("distill-demo failed:", err);
  process.exit(1);
});
