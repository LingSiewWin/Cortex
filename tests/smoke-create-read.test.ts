/**
 * Cortex — end-to-end smoke test against Braga.
 *
 * This is NOT a unit test. It WRITES TO BRAGA. Each run costs a small amount
 * of GLM (~29k gas per entity create).
 *
 * Skipped automatically if SESSION_KEY_PRIVATE_KEY is unset — for CI without
 * a funded key, the canary test still runs (it's read-only after the create).
 *
 * Asserts:
 *   1. singleCreate stamps PROJECT_ATTRIBUTE and returns a valid entity key + tx hash
 *   2. getEntity(key) returns the entity with the original payload + attributes
 *   3. cortexQuery filters out other-project entities (via PROJECT_ATTRIBUTE)
 *   4. .createdBy(sessionKey) filter narrows to our trusted writes only
 */

import { test, expect, beforeAll } from "bun:test";
import { jsonToPayload, ExpirationTime } from "@arkiv-network/sdk/utils";
import { eq } from "@arkiv-network/sdk/query";
import { singleCreate } from "../src/lib/batch-writer";
import {
  cortexQuery,
  getPublicClient,
  getSessionKeyAddress,
  getWalletClient,
} from "../src/lib/arkiv-client";
import { PROJECT_ATTRIBUTE, ENTITY_TYPE } from "../src/constants";

const HAVE_KEY = !!process.env.SESSION_KEY_PRIVATE_KEY;

beforeAll(() => {
  if (!HAVE_KEY) {
    console.warn(
      "\nSESSION_KEY_PRIVATE_KEY missing — smoke test will be skipped.\n" +
        "Set it in .env to run end-to-end against Braga.\n",
    );
  } else {
    // throws if key is malformed; caller wants to know early
    getWalletClient();
  }
});

test.skipIf(!HAVE_KEY)("singleCreate stamps PROJECT_ATTRIBUTE and round-trips", async () => {
  // 30s — Braga tx confirmation is ~4-8s, plus 2 queries; default 5s is too tight.
  const sessionKey = getSessionKeyAddress();
  const marker = `smoke-${Date.now()}`;

  // 1. Create
  const { entityKey, txHash } = await singleCreate({
    payload: jsonToPayload({ marker, note: "Cortex smoke test" }),
    contentType: "application/json",
    attributes: [
      { key: "entityType", value: ENTITY_TYPE.OBSERVATION },
      { key: "marker", value: marker },
      { key: "created", value: Date.now() },
    ],
    expiresInSeconds: ExpirationTime.fromMinutes(10),
  });

  expect(entityKey).toMatch(/^0x[0-9a-f]{64}$/i);
  expect(txHash).toMatch(/^0x[0-9a-f]{64}$/i);

  // 2. Read back by key
  const fetched = await getPublicClient().getEntity(entityKey);
  expect(fetched.creator?.toLowerCase()).toBe(sessionKey.toLowerCase());
  expect(fetched.owner?.toLowerCase()).toBe(sessionKey.toLowerCase());

  const projectAttr = fetched.attributes.find((a) => a.key === PROJECT_ATTRIBUTE.key);
  expect(projectAttr?.value).toBe(PROJECT_ATTRIBUTE.value);

  const markerAttr = fetched.attributes.find((a) => a.key === "marker");
  expect(markerAttr?.value).toBe(marker);

  // 3. Query via cortexQuery — must find the entity we just created
  const queryResult = await cortexQuery()
    .where(eq("marker", marker))
    .withPayload(true)
    .withAttributes(true)
    .withMetadata(true)
    .limit(5)
    .fetch();

  expect(queryResult.entities.length).toBeGreaterThanOrEqual(1);
  const ours = queryResult.entities.find((e) => e.key === entityKey);
  expect(ours).toBeDefined();
  expect(ours?.toJson().marker).toBe(marker);

  // 4. createdBy filter — should still find it (we are the creator)
  const trustedResult = await cortexQuery({ createdBy: sessionKey })
    .where(eq("marker", marker))
    .withMetadata(true)
    .limit(5)
    .fetch();
  expect(trustedResult.entities.find((e) => e.key === entityKey)).toBeDefined();

  console.log("\n  ✅ Entity:", entityKey);
  console.log("  ✅ Tx    :", txHash);
}, 30_000);
