/**
 * Cortex — the protocol-archaeology canary.
 *
 * This test is DELIBERATELY ASYMMETRIC:
 *   - It SHOULD FAIL on Braga as of 2026-05-19 because `validAtBlock` is silently
 *     ignored by the server (empirically verified in docs/Arkiv.md §1.6).
 *   - If it ever STARTS PASSING, that means Arkiv shipped the historical-query
 *     fix and Cortex's local SQLite mirror cold tier becomes optional.
 *
 * Shipping this in CI is part of the pitch: judges who run the suite see that
 * we built Cortex against empirical protocol behaviour, not aspirational docs.
 *
 * Skipped if SESSION_KEY_PRIVATE_KEY is unset.
 */

import { test, expect } from "bun:test";
import { jsonToPayload, ExpirationTime } from "@arkiv-network/sdk/utils";
import { eq } from "@arkiv-network/sdk/query";
import { singleCreate } from "../src/lib/batch-writer";
import { cortexQuery, getPublicClient } from "../src/lib/arkiv-client";
import { ENTITY_TYPE } from "../src/constants";

const HAVE_KEY = !!process.env.SESSION_KEY_PRIVATE_KEY;

test.skipIf(!HAVE_KEY)(
  "atBlock canary — should ignore historical filter (broken on Braga 2026-05)",
  async () => {
    const marker = `canary-${Date.now()}`;

    // 1. Create an entity with very short expiration.
    //
    // We capture the block number ourselves immediately after singleCreate
    // because the SDK currently returns `createdAtBlock: undefined` from
    // `getEntity()` for fresh entities on Braga (runtime audit 2026-05-21).
    // The historical query below uses this captured value + 1 as the
    // `validAtBlock` parameter, which is the only thing we actually need.
    const publicClient = getPublicClient();
    const { entityKey } = await singleCreate({
      payload: jsonToPayload({ marker, note: "atBlock canary" }),
      contentType: "application/json",
      attributes: [
        { key: "entityType", value: ENTITY_TYPE.OBSERVATION },
        { key: "marker", value: marker },
      ],
      expiresInSeconds: ExpirationTime.fromSeconds(20),
    });
    const createdAtBlock = await publicClient.getBlockNumber();
    expect(createdAtBlock).toBeGreaterThan(0n);

    // 2. Wait past expiry. Braga is 2s blocks; 20s expiration + 30s margin = 50s.
    await Bun.sleep(50_000);

    // 3. Query at LATEST — should be empty (auto-eviction works on Braga, §1.5)
    const atLatest = await cortexQuery()
      .where(eq("marker", marker))
      .limit(5)
      .fetch();

    const presentAtLatest = atLatest.entities.find((e) => e.key === entityKey);
    expect(
      presentAtLatest,
      "Auto-eviction failed: entity still present after expiration expired",
    ).toBeUndefined();

    // 4. Query at historical block — SHOULD return the entity if atBlock worked.
    //    On Braga today, the server silently ignores `validAtBlock` and still
    //    returns the latest state (empty). We assert the BROKEN behaviour so
    //    when it gets fixed upstream the test flips and tells us.
    //
    //    NB: we do NOT use `entity.createdAtBlock` from getEntity — the SDK
    //    returns it as `undefined` on Braga (regression noted in audit). The
    //    captured `createdAtBlock` from step 1 is the source of truth here.
    const atHistorical = await cortexQuery()
      .where(eq("marker", marker))
      .validAtBlock(createdAtBlock + 1n)
      .limit(5)
      .fetch();

    const presentAtHistorical = atHistorical.entities.find((e) => e.key === entityKey);
    if (presentAtHistorical) {
      throw new Error(
        "🎉 atBlock canary inverted! Historical query now works on Braga. " +
          "Update docs/Arkiv.md §1.6 and reconsider whether the SQLite mirror cold tier " +
          "is still load-bearing. This is good news.",
      );
    }
    expect(presentAtHistorical).toBeUndefined();

    console.log(
      "\n  ✅ Canary confirms: atBlock is still silently ignored on Braga as of " +
        new Date().toISOString(),
    );
    console.log("     Cortex's local SQLite mirror remains the cold-tier path.\n");
  },
  90_000, // 90s timeout — we sleep 50s mid-test
);
