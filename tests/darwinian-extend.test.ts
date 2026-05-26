/**
 * Phase 5 — additive extend math tests.
 *
 * Deployed Braga `extend` is ADDITIVE (`expiresAt += expiresIn`), VERIFIED on-chain
 * 2026-05-25 (docs/arkiv-network/2026-05-25-extend-semantics-VERIFIED.md). So
 * `expiresIn` IS the net lease gain — we pass `reinforcementSeconds` alone, NOT
 * `remaining + reinforcement` (which would double-count remaining and balloon leases).
 * The `remaining <= 0` lookup is retained only to skip expired (auto-deleted) entities.
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

describe("reinforce — additive extend math", () => {
  test("ADDITIVE: expiresIn = reinforcement alone (NOT remaining + reinforcement)", async () => {
    let observedExpiresIn = -1;

    await reinforce(FAKE_KEY, 200, {
      getExpiresAtBlock: async () => 999_999n,
      remainingSeconds: async () => 100, // remaining is large, but must NOT be added
      sendExtend: async ({ entityKey, expiresIn }) => {
        observedExpiresIn = expiresIn;
        return { entityKey, txHash: FAKE_TX };
      },
    });

    // The chain adds expiresIn to expiresAt, so the net gain is exactly the
    // reinforcement. The old REPLACE formula (300) would double-count remaining.
    expect(observedExpiresIn).toBe(200);
    expect(observedExpiresIn).not.toBe(300);
  });

  test("net gain is independent of remaining (1d remaining, 24h reinforcement → expiresIn=86400)", async () => {
    let observedExpiresIn = -1;
    await reinforce(FAKE_KEY, 86400, {
      getExpiresAtBlock: async () => 1n,
      remainingSeconds: async () => 86400, // a day left already
      sendExtend: async ({ entityKey, expiresIn }) => {
        observedExpiresIn = expiresIn;
        return { entityKey, txHash: FAKE_TX };
      },
    });
    expect(observedExpiresIn).toBe(86400); // +24h, not +48h
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

  test("expiresIn is the reinforcement regardless of (fractional) remaining", async () => {
    let observed = -1;
    await reinforce(FAKE_KEY, 100, {
      getExpiresAtBlock: async () => 1n,
      remainingSeconds: async () => 50.9, // remaining is only used for the expired-skip check
      sendExtend: async ({ entityKey, expiresIn }) => {
        observed = expiresIn;
        return { entityKey, txHash: FAKE_TX };
      },
    });
    expect(observed).toBe(100);
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
    // Additive: each expiresIn is its own reinforcement, NOT remaining + reinforcement.
    expect(observed!.find((x) => x.entityKey === FAKE_KEY)?.expiresIn).toBe(200);
    expect(observed!.find((x) => x.entityKey === FAKE_KEY_2)?.expiresIn).toBe(500);
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
    expect(observed?.[0]?.expiresIn).toBe(500);
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
