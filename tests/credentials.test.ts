/**
 * Cortex — unit tests for resolveCredentials() (the centralized resolver).
 *
 * Verifies env → config precedence + the `source` map for every credential,
 * including the owner-from-config fallback that the scattered call sites lacked.
 * Hermetic: empty temp CORTEX_CONFIG_PATH, all credential env vars cleared.
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const CRED_ENVS = [
  "USER_PRIMARY_ADDRESS",
  "SESSION_KEY_PRIVATE_KEY",
  "CORTEX_USER_SIGNATURE",
  "CORTEX_USER_PRIVATE_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "VOYAGE_API_KEY",
  "COHERE_API_KEY",
];
let dir: string;
const SAVED: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cortex-rc-"));
  SAVED.CORTEX_CONFIG_PATH = process.env.CORTEX_CONFIG_PATH;
  process.env.CORTEX_CONFIG_PATH = join(dir, "config.json");
  for (const k of CRED_ENVS) {
    SAVED[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  if (SAVED.CORTEX_CONFIG_PATH === undefined) delete process.env.CORTEX_CONFIG_PATH;
  else process.env.CORTEX_CONFIG_PATH = SAVED.CORTEX_CONFIG_PATH;
  for (const k of CRED_ENVS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k]!;
  }
  rmSync(dir, { recursive: true, force: true });
});

async function withConfig(cfg: Record<string, unknown>) {
  const m = await import("../src/lib/cortex-config.ts");
  m._resetConfigCache();
  if (Object.keys(cfg).length) m.writeConfig(cfg as never);
  m._resetConfigCache();
}
async function resolve() {
  (await import("../src/lib/cortex-config.ts"))._resetConfigCache();
  return (await import("../src/lib/credentials.ts")).resolveCredentials();
}

const OWNER_ENV = "0x1111111111111111111111111111111111111111";
const OWNER_CFG = "0x2222222222222222222222222222222222222222";
const SK_ENV = "0x" + "11".repeat(32);
const SK_CFG = "0x" + "22".repeat(32);
const GOOD_EMB = "sk-test-abcdef0123456789";

describe("everything empty", () => {
  test("all null, all source 'none'", async () => {
    await withConfig({});
    const c = await resolve();
    expect(c.sessionKeyPrivate).toBeNull();
    expect(c.ownerEOA).toBeNull();
    expect(c.userSignature).toBeNull();
    expect(c.embedding).toBeNull();
    expect(c.source).toEqual({ sessionKey: "none", owner: "none", signature: "none", embedding: "none" });
  });
});

describe("session key", () => {
  test("env wins, source env", async () => {
    process.env.SESSION_KEY_PRIVATE_KEY = SK_ENV;
    await withConfig({ sessionKeyPrivate: SK_CFG });
    const c = await resolve();
    expect(c.sessionKeyPrivate).toBe(SK_ENV);
    expect(c.source.sessionKey).toBe("env");
  });
  test("config fallback, source config", async () => {
    await withConfig({ sessionKeyPrivate: SK_CFG });
    const c = await resolve();
    expect(c.sessionKeyPrivate).toBe(SK_CFG);
    expect(c.source.sessionKey).toBe("config");
  });
  test("malformed env ignored", async () => {
    process.env.SESSION_KEY_PRIVATE_KEY = "0xnothex";
    await withConfig({ sessionKeyPrivate: SK_CFG });
    const c = await resolve();
    expect(c.sessionKeyPrivate).toBe(SK_CFG);
    expect(c.source.sessionKey).toBe("config");
  });
});

describe("owner EOA", () => {
  test("env wins, source env", async () => {
    process.env.USER_PRIMARY_ADDRESS = OWNER_ENV;
    await withConfig({ ownerAddress: OWNER_CFG });
    const c = await resolve();
    expect(c.ownerEOA?.toLowerCase()).toBe(OWNER_ENV);
    expect(c.source.owner).toBe("env");
  });
  test("config fallback (THE FIX), source config", async () => {
    await withConfig({ ownerAddress: OWNER_CFG });
    const c = await resolve();
    expect(c.ownerEOA?.toLowerCase()).toBe(OWNER_CFG);
    expect(c.source.owner).toBe("config");
  });
  test("derived from CORTEX_USER_PRIVATE_KEY, source derived", async () => {
    const pk = generatePrivateKey();
    const expected = privateKeyToAccount(pk).address.toLowerCase();
    process.env.CORTEX_USER_PRIVATE_KEY = pk;
    await withConfig({});
    const c = await resolve();
    expect(c.ownerEOA?.toLowerCase()).toBe(expected);
    expect(c.source.owner).toBe("derived");
    expect(c.userPrivateKey).toBe(pk);
  });
});

describe("signature", () => {
  test("env wins, source env", async () => {
    process.env.CORTEX_USER_SIGNATURE = "0xdeadbeef";
    await withConfig({ userSignature: "0xabcabc" });
    const c = await resolve();
    expect(c.userSignature).toBe("0xdeadbeef");
    expect(c.source.signature).toBe("env");
  });
  test("config fallback, source config", async () => {
    await withConfig({ userSignature: "0xabcabc" });
    const c = await resolve();
    expect(c.userSignature).toBe("0xabcabc");
    expect(c.source.signature).toBe("config");
  });
});

describe("embedding", () => {
  test("env provider order: OpenAI before OpenRouter", async () => {
    process.env.OPENAI_API_KEY = GOOD_EMB;
    process.env.OPENROUTER_API_KEY = GOOD_EMB + "xx";
    await withConfig({});
    const c = await resolve();
    expect(c.embedding).toEqual({ key: GOOD_EMB, provider: "openai" });
    expect(c.source.embedding).toBe("env");
  });
  test("config fallback uses its provider", async () => {
    await withConfig({ embeddingKey: GOOD_EMB, embeddingProvider: "cohere" });
    const c = await resolve();
    expect(c.embedding).toEqual({ key: GOOD_EMB, provider: "cohere" });
    expect(c.source.embedding).toBe("config");
  });
  test("config without provider defaults to openai (matches embedText)", async () => {
    await withConfig({ embeddingKey: GOOD_EMB });
    const c = await resolve();
    expect(c.embedding).toEqual({ key: GOOD_EMB, provider: "openai" });
  });
  test("placeholder/too-short key rejected", async () => {
    process.env.OPENAI_API_KEY = "sk-x"; // < 16 chars
    await withConfig({});
    const c = await resolve();
    expect(c.embedding).toBeNull();
    expect(c.source.embedding).toBe("none");
  });
});
