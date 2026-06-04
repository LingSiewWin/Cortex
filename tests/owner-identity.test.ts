/**
 * Tests for the dashboard's process-scoped identity singleton.
 *
 * Covers: env-default resolution, browser-source adoption, signature
 * verification, source transitions, and test-seam isolation.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "@arkiv-network/sdk";
import {
  adopt,
  getEffective,
  _resetOwnerIdentity,
} from "../src/agent/owner-identity";
import { _resetConfigCache } from "../src/lib/cortex-config";
import { keyDerivationMessage } from "../src/lib/derivation-message";

const PK_A = ("0x" + "11".repeat(32)) as Hex;
const PK_B = ("0x" + "22".repeat(32)) as Hex;

const accountA = privateKeyToAccount(PK_A);
const accountB = privateKeyToAccount(PK_B);

const SAVED_ENV = {
  USER_PRIMARY_ADDRESS: process.env.USER_PRIMARY_ADDRESS,
  CORTEX_USER_SIGNATURE: process.env.CORTEX_USER_SIGNATURE,
  CORTEX_USER_PRIVATE_KEY: process.env.CORTEX_USER_PRIVATE_KEY,
};

// Hermetic config: point CORTEX_CONFIG_PATH at an empty temp dir so readConfig()
// returns null instead of leaking the developer's real ~/.cortex/config.json
// (which exists after `cortex auth` and otherwise supplies an owner/signature).
let cfgDir: string;
const SAVED_CONFIG_PATH = process.env.CORTEX_CONFIG_PATH;

beforeEach(() => {
  cfgDir = mkdtempSync(join(tmpdir(), "cortex-oid-"));
  process.env.CORTEX_CONFIG_PATH = join(cfgDir, "config.json"); // never created → absent
  delete process.env.USER_PRIMARY_ADDRESS;
  delete process.env.CORTEX_USER_SIGNATURE;
  delete process.env.CORTEX_USER_PRIVATE_KEY;
  _resetConfigCache();
  _resetOwnerIdentity();
});

afterEach(() => {
  if (SAVED_CONFIG_PATH === undefined) delete process.env.CORTEX_CONFIG_PATH;
  else process.env.CORTEX_CONFIG_PATH = SAVED_CONFIG_PATH;
  if (SAVED_ENV.USER_PRIMARY_ADDRESS !== undefined) process.env.USER_PRIMARY_ADDRESS = SAVED_ENV.USER_PRIMARY_ADDRESS;
  if (SAVED_ENV.CORTEX_USER_SIGNATURE !== undefined) process.env.CORTEX_USER_SIGNATURE = SAVED_ENV.CORTEX_USER_SIGNATURE;
  if (SAVED_ENV.CORTEX_USER_PRIVATE_KEY !== undefined) process.env.CORTEX_USER_PRIVATE_KEY = SAVED_ENV.CORTEX_USER_PRIVATE_KEY;
  rmSync(cfgDir, { recursive: true, force: true });
  _resetConfigCache();
  _resetOwnerIdentity();
});

test("source 'none' when no env and no adoption", async () => {
  const view = await getEffective();
  expect(view.source).toBe("none");
  expect(view.ownerAddress).toBeNull();
  expect(view.payloadKey).toBeNull();
});

test("source 'env' when USER_PRIMARY_ADDRESS + CORTEX_USER_PRIVATE_KEY set", async () => {
  process.env.USER_PRIMARY_ADDRESS = accountA.address;
  process.env.CORTEX_USER_PRIVATE_KEY = PK_A;
  const view = await getEffective();
  expect(view.source).toBe("env");
  expect(view.ownerAddress?.toLowerCase()).toBe(accountA.address.toLowerCase());
  expect(view.payloadKey).not.toBeNull();
});

test("adopt swaps state and source becomes 'browser'", async () => {
  process.env.USER_PRIMARY_ADDRESS = accountA.address;
  process.env.CORTEX_USER_PRIVATE_KEY = PK_A;

  const message = keyDerivationMessage(accountB.address);
  const signature = await accountB.signMessage({ message });

  const view = await adopt({ address: accountB.address as Hex, signature: signature as Hex });
  expect(view.source).toBe("browser");
  expect(view.ownerAddress?.toLowerCase()).toBe(accountB.address.toLowerCase());

  const subsequent = await getEffective();
  expect(subsequent.source).toBe("browser");
  expect(subsequent.ownerAddress?.toLowerCase()).toBe(accountB.address.toLowerCase());
});

test("adopt rejects signature that doesn't recover to address", async () => {
  const message = keyDerivationMessage(accountA.address);
  const wrongSig = await accountB.signMessage({ message }); // signed by B, claimed for A
  await expect(
    adopt({ address: accountA.address as Hex, signature: wrongSig as Hex }),
  ).rejects.toThrow(/signature did not verify/i);
});

test("adopt rejects malformed Hex", async () => {
  await expect(
    adopt({ address: "0xnothex" as Hex, signature: "0xalsonothex" as Hex }),
  ).rejects.toThrow();
});

test("_resetOwnerIdentity returns to env source", async () => {
  process.env.USER_PRIMARY_ADDRESS = accountA.address;
  process.env.CORTEX_USER_PRIVATE_KEY = PK_A;

  const message = keyDerivationMessage(accountB.address);
  const signature = await accountB.signMessage({ message });
  await adopt({ address: accountB.address as Hex, signature: signature as Hex });
  expect((await getEffective()).source).toBe("browser");

  _resetOwnerIdentity();
  expect((await getEffective()).source).toBe("env");
});
