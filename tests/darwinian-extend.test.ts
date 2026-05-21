/**
 * Phase 5 — accumulative extend math tests.
 *
 * Verifies the load-bearing claim from CLAUDE.md "Accumulative extend":
 *
 *     new_btl_seconds = remaining_seconds + reinforcement_seconds
 *
 * If this math is wrong (e.g. we pass `reinforcement_seconds` alone), Arkiv's
 * REPLACE-not-ADD `extend` reverts whenever `remaining > reinforcement` — which
 * is exactly the regime Cortex memories enter as they get cited.
 *
 * Pure-arithmetic tests via dependency injection — no Braga RPC needed.
 */

import { test, expect, describe } from "bun:test";
import {
  reinforce,
  reinforceBatch,
  EntityAlreadyExpiredError,
} from "../src/darwinian/extend.ts";
import type { Hash, Hex } from "@arkiv-network/sdk";

const FAKE_KEY = "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;
const FAKE_KEY_2 = "0x2222222222222222222222222222222222222222222222222222222222222222" as Hex;
const FAKE_TX = "0xdeadbeef" as Hash;

describe("reinforce — accumulative extend math", () => {
  test("remaining=100s + reinforcement=200s → expiresIn=300s (NOT 200)", async () => {
    let observedExpiresIn = -1;

    await reinforce(FAKE_KEY, 200, {
      getExpiresAtBlock: async () => 999_999n, // value irrelevant; remainingSeconds is stubbed
      remainingSeconds: async () => 100,
      sendExtend: async ({ entityKey, expiresIn }) => {
        observedExpiresIn = expiresIn;
        return { entityKey, txHash: FAKE_TX };
      },
    });

    expect(observedExpiresIn).toBe(300);
    // The critical anti-regression: it MUST NOT equal the reinforcement alone.
    expect(observedExpiresIn).not.toBe(200);
  });

  test("remaining=86400s (1d) + reinforcement=86400s (24h) → expiresIn=172800s", async () => {
    let observedExpiresIn = -1;
    await reinforce(FAKE_KEY, 86400, {
      getExpiresAtBlock: async () => 1n,
      remainingSeconds: async () => 86400,
      sendExtend: async ({ entityKey, expiresIn }) => {
        observedExpiresIn = expiresIn;
        return { entityKey, txHash: FAKE_TX };
      },
    });
    expect(observedExpiresIn).toBe(172800);
  });

  test("remaining=0 → throws EntityAlreadyExpiredError (no extend tx attempted)", async () => {
    let sendCalled = false;
    await expect(
      reinforce(FAKE_KEY, 100, {
        getExpiresAtBlock: async () => 1n,
        remainingSeconds: async () => 0,
        sendExtend: async () => {
          sendCalled = true;
          return { entityKey: FAKE_KEY, txHash: FAKE_TX };
        },
      }),
    ).rejects.toBeInstanceOf(EntityAlreadyExpiredError);
    expect(sendCalled).toBe(false);
  });

  test("returns the tx hash from the SDK", async () => {
    const out = await reinforce(FAKE_KEY, 60, {
      getExpiresAtBlock: async () => 1n,
      remainingSeconds: async () => 10,
      sendExtend: async () => ({ entityKey: FAKE_KEY, txHash: "0xbeefcafe" as Hash }),
    });
    expect(out).toBe("0xbeefcafe");
  });

  test("non-positive reinforcement → throws synchronously", async () => {
    await expect(reinforce(FAKE_KEY, 0)).rejects.toThrow();
    await expect(reinforce(FAKE_KEY, -1)).rejects.toThrow();
    await expect(reinforce(FAKE_KEY, 1.5)).rejects.toThrow();
  });

  test("float remaining gets floored before adding reinforcement", async () => {
    let observed = -1;
    await reinforce(FAKE_KEY, 100, {
      getExpiresAtBlock: async () => 1n,
      remainingSeconds: async () => 50.9,
      sendExtend: async ({ entityKey, expiresIn }) => {
        observed = expiresIn;
        return { entityKey, txHash: FAKE_TX };
      },
    });
    // floor(50.9) + 100 = 150
    expect(observed).toBe(150);
  });
});

describe("reinforceBatch — bundled accumulative extend", () => {
  test("bundles N items into a single mutateEntities call with correct math per item", async () => {
    let observed: { entityKey: Hex; expiresIn: number }[] | undefined;
    await reinforceBatch(
      [
        { entityKey: FAKE_KEY, reinforcementSeconds: 200 },
        { entityKey: FAKE_KEY_2, reinforcementSeconds: 500 },
      ],
      {
        getExpiresAtBlock: async (key) => (key === FAKE_KEY ? 1n : 2n),
        remainingSeconds: async (block) => (block === 1n ? 100 : 1000),
        sendMutate: async (args) => {
          observed = args.extensions;
          return { txHash: FAKE_TX };
        },
      },
    );

    expect(observed).toBeDefined();
    expect(observed!.length).toBe(2);
    expect(observed!.find((x) => x.entityKey === FAKE_KEY)?.expiresIn).toBe(300);
    expect(observed!.find((x) => x.entityKey === FAKE_KEY_2)?.expiresIn).toBe(1500);
  });

  test("drops expired entries, keeps live ones, still produces one tx", async () => {
    let observed: { entityKey: Hex; expiresIn: number }[] | undefined;
    await reinforceBatch(
      [
        { entityKey: FAKE_KEY, reinforcementSeconds: 200 }, // expired
        { entityKey: FAKE_KEY_2, reinforcementSeconds: 500 }, // alive
      ],
      {
        getExpiresAtBlock: async (key) => (key === FAKE_KEY ? 1n : 2n),
        remainingSeconds: async (block) => (block === 1n ? 0 : 1000),
        sendMutate: async (args) => {
          observed = args.extensions;
          return { txHash: FAKE_TX };
        },
      },
    );

    expect(observed?.length).toBe(1);
    expect(observed?.[0]?.entityKey).toBe(FAKE_KEY_2);
    expect(observed?.[0]?.expiresIn).toBe(1500);
  });

  test("all entries expired → throws EntityAlreadyExpiredError", async () => {
    await expect(
      reinforceBatch(
        [
          { entityKey: FAKE_KEY, reinforcementSeconds: 200 },
          { entityKey: FAKE_KEY_2, reinforcementSeconds: 500 },
        ],
        {
          getExpiresAtBlock: async () => 1n,
          remainingSeconds: async () => 0,
          sendMutate: async () => {
            throw new Error("should not be called");
          },
        },
      ),
    ).rejects.toBeInstanceOf(EntityAlreadyExpiredError);
  });

  test("empty items → throws", async () => {
    await expect(reinforceBatch([])).rejects.toThrow();
  });
});
