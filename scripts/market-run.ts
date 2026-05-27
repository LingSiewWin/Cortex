/**
 * Cortex — Synaptic Market proof (Phase 16 integration).
 *
 * Proves the market's CONTRACT-FREE core end-to-end on Braga:
 *   1. publishListing — seal a distilled rule under a fresh per-listing AES key
 *      and write a LISTING entity to Arkiv (public metadata, encrypted payload)
 *   2. browseListings — discover it via an Arkiv attribute query (the
 *      "queryable public DB" pitch) WITHOUT decrypting
 *   3. show the payload is on-chain but unreadable without a purchase
 *
 * What this does NOT cover: the on-chain escrow (buy → Grant event → grant
 * entity) needs the deployed `SynapticMarket.sol` + `MARKET.contractAddress`
 * wired (currently the zero address). The buy/grant code (decrypt-grant.ts) is
 * implemented and unit-tested; deploying the contract is the remaining step to
 * run it live. See JUDGE_DEFENSE.md "Is the Synaptic Market just a fake judge?".
 *
 * Run:  bun run market-run
 */

import { publishListing } from "../src/market/publish";
import { browseListings } from "../src/market/decrypt-grant";
import { getPublicClient } from "../src/lib/arkiv-client";
import { initMirrorDb } from "../src/mirror/db";
import { BRAGA } from "../src/constants";

const RULE_TEXT =
  "Decline token launches whose deployer was funded in the last 24h and whose liquidity lock is under 30 days — historical rug-pull correlation is high.";
const RULE_TAG = "rug-policy";

function explorerTx(h: string): string {
  return `${BRAGA.explorer}tx/${h}`;
}

async function main(): Promise<void> {
  console.log("\n=== Cortex market-run (Synaptic Market core, real Braga) ===\n");
  await initMirrorDb();

  // 1. Publish a listing (no userKey → persistence skipped; fine for this proof).
  console.log("[1] Publishing encrypted rule listing…");
  const listing = await publishListing({
    ruleText: RULE_TEXT,
    ruleTag: RULE_TAG,
    confidence: 87,
    priceWei: 1_000_000_000_000_000n, // 0.001 GLM
  });
  console.log(`    listing ${listing.entityKey}`);
  console.log(`    ${explorerTx(listing.txHash)}`);
  console.log(
    `    sealed under a fresh per-listing AES-256 key (${listing.decryptionKey.length} bytes, held by seller)\n`,
  );

  // 2. Browse — discover via Arkiv attribute query (no decryption).
  console.log(`[2] Browsing listings tagged "${RULE_TAG}" (Arkiv attribute query)…`);
  const found = await browseListings({ ruleTag: RULE_TAG });
  console.log(`    ${found.length} listing(s) discovered:`);
  for (const l of found.slice(0, 5)) {
    console.log(
      `      ${l.entityKey.slice(0, 12)}… conf=${l.confidence} price=${l.priceWei} seller=${l.seller.slice(0, 10)}…`,
    );
  }
  const mine = found.find((l) => l.entityKey === listing.entityKey);
  if (!mine) {
    console.error("\n❌ Published listing not found via browse — query mismatch.");
    process.exit(2);
  }

  // 3. Show the payload is on-chain but encrypted (discoverable ≠ readable).
  console.log("\n[3] Confirming the payload is on-chain but encrypted…");
  const entity = await getPublicClient().getEntity(listing.entityKey);
  const ct = entity.payload;
  if (!ct || ct.length === 0) {
    console.error("❌ listing has no payload");
    process.exit(3);
  }
  let readableAsText = false;
  try {
    const txt = new TextDecoder("utf-8", { fatal: true }).decode(ct.slice(0, 32));
    readableAsText = txt.includes(RULE_TEXT.slice(0, 8));
  } catch {
    readableAsText = false;
  }
  console.log(`    payload: ${ct.length} bytes, plaintext-readable: ${readableAsText}`);
  if (readableAsText) {
    console.error("❌ payload is NOT encrypted — the rule leaked in plaintext!");
    process.exit(4);
  }

  console.log(
    "\n✅ Synaptic Market core proven: a rule is published encrypted, discoverable",
  );
  console.log(
    "   via attribute query, and unreadable on-chain without a purchase grant.",
  );
  console.log(
    "   (On-chain escrow buy→grant needs SynapticMarket.sol deployed — see JUDGE_DEFENSE.md.)",
  );
}

main().catch((err) => {
  console.error("market-run failed:", err);
  process.exit(1);
});
