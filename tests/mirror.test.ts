/**
 * Cortex mirror — end-to-end test against Braga.
 *
 * Verifies:
 *   1. Daemon starts, hydrates the events stream, persists state
 *   2. A fresh Cortex entity appears in the mirror within N blocks
 *   3. Replay reconstruction matches the maintained entities table
 *
 * Skipped if SESSION_KEY_PRIVATE_KEY is unset. Writes to a temp SQLite path
 * so it doesn't pollute your main mirror.
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { jsonToPayload, ExpirationTime } from "@arkiv-network/sdk/utils";
import { singleCreate } from "../src/lib/batch-writer";
import { ENTITY_TYPE } from "../src/constants";
import { startMirrorDaemon, type DaemonHandle } from "../src/mirror/daemon";
import { getMirroredEntity, replayEntity } from "../src/mirror/replay";
import { closeMirrorDb } from "../src/mirror/db";
import { getPublicClient } from "../src/lib/arkiv-client";

const HAVE_KEY = !!process.env.SESSION_KEY_PRIVATE_KEY;
const TEST_DB_PATH = `./cortex-mirror.test-${Date.now()}.sqlite`;

let handle: DaemonHandle | undefined;

beforeAll(() => {
  process.env.CORTEX_MIRROR_PATH = TEST_DB_PATH;
});

afterAll(async () => {
  if (handle) handle.stop();
  closeMirrorDb();
  // best-effort cleanup
  try {
    await Bun.file(TEST_DB_PATH).delete();
    await Bun.file(`${TEST_DB_PATH}-wal`).delete();
    await Bun.file(`${TEST_DB_PATH}-shm`).delete();
  } catch {
    /* ignore */
  }
});

test.skipIf(!HAVE_KEY)(
  "mirror daemon ingests a freshly created Cortex entity",
  async () => {
    // Start daemon from current block (no historical backfill)
    const startBlock = (await getPublicClient().getBlockTiming()).currentBlock;
    handle = await startMirrorDaemon({ fromBlock: startBlock, verbose: false });

    // Give the watcher one tick to subscribe
    await Bun.sleep(1500);

    // Create a Cortex entity
    const marker = `mirror-${Date.now()}`;
    const { entityKey, txHash } = await singleCreate({
      payload: jsonToPayload({ marker, note: "mirror test" }),
      contentType: "application/json",
      attributes: [
        { key: "entityType", value: ENTITY_TYPE.OBSERVATION },
        { key: "marker", value: marker },
      ],
      expiresInSeconds: ExpirationTime.fromMinutes(5),
    });
    console.log("\n  [mirror.test] created", entityKey, "tx", txHash);

    // Poll the mirror until the entity appears or we hit a deadline
    const deadline = Date.now() + 20_000;
    let mirrored = await getMirroredEntity(entityKey);
    while (!mirrored && Date.now() < deadline) {
      await Bun.sleep(1000);
      mirrored = await getMirroredEntity(entityKey);
    }

    expect(mirrored, "entity not picked up by mirror within 20s").not.toBeNull();
    expect(mirrored?.state).toBe("live");
    expect(mirrored?.attributes.some((a) => a.key === "marker" && a.value === marker)).toBe(true);

    // Verify replay reconstructs the same owner / state
    const replayed = await replayEntity(entityKey);
    expect(replayed).not.toBeNull();
    expect(replayed?.state).toBe("live");
    expect(replayed?.owner?.toLowerCase()).toBe(mirrored?.owner.toLowerCase());

    console.log("  ✅ Mirror caught entity in", replayed?.events.length, "events");
  },
  60_000, // create + 20s poll + safety margin
);
