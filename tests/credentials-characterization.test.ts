/**
 * Cortex — CHARACTERIZATION tests for credential resolution.
 *
 * These lock the CURRENT (pre-refactor) behavior of how each credential resolves
 * from env vs. ~/.cortex/config.json, so the `resolveCredentials()` centralization
 * cannot silently change a working path. Precedence everywhere is env → config.
 *
 * Two CURRENT GAPS are captured here as explicit assertions and flagged:
 *   - owner-identity `getEffective().ownerAddress` is env-only (no config fallback)
 *   - (the MCP server's owner read is also env-only — covered in the MCP test)
 * These two assertions are FLIPPED by Task 6 / Task 7 once the gaps are fixed.
 *
 * Hermetic: CORTEX_CONFIG_PATH points at an empty temp dir; all credential env
 * vars are cleared in beforeEach and restored in afterEach.
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { keyDerivationMessage } from "../src/lib/crypto.ts";

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
  dir = mkdtempSync(join(tmpdir(), "cortex-cred-"));
  SAVED.CORTEX_CONFIG_PATH = process.env.CORTEX_CONFIG_PATH;
  process.env.CORTEX_CONFIG_PATH = join(dir, "config.json"); // absent until writeConfig
  for (const k of CRED_ENVS) {
    SAVED[k] = process.env[k];
    delete process.env[k];
  }
});

// Drop the memoized wallet client between tests so session-key resolution
// re-reads env/config (getWalletClient caches the first-resolved key).
async function freshArkivClients() {
  (await import("../src/lib/arkiv-client.ts"))._resetArkivClients();
}

afterEach(() => {
  if (SAVED.CORTEX_CONFIG_PATH === undefined) delete process.env.CORTEX_CONFIG_PATH;
  else process.env.CORTEX_CONFIG_PATH = SAVED.CORTEX_CONFIG_PATH;
  for (const k of CRED_ENVS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k]!;
  }
  rmSync(dir, { recursive: true, force: true });
});

const OWNER_ENV = "0x1111111111111111111111111111111111111111";
const OWNER_CFG = "0x2222222222222222222222222222222222222222";
const SK_ENV = ("0x" + "11".repeat(32));
const SK_CFG = ("0x" + "22".repeat(32));

async function freshConfig() {
  const m = await import("../src/lib/cortex-config.ts");
  m._resetConfigCache();
  return m;
}

describe("owner resolution via arkiv-client.getUserPrimaryEOA (already has config fallback)", () => {
  test("env wins over config", async () => {
    process.env.USER_PRIMARY_ADDRESS = OWNER_ENV;
    const { writeConfig } = await freshConfig();
    writeConfig({ ownerAddress: OWNER_CFG });
    (await freshConfig())._resetConfigCache();
    const { getUserPrimaryEOA } = await import("../src/lib/arkiv-client.ts");
    expect(getUserPrimaryEOA().toLowerCase()).toBe(OWNER_ENV);
  });

  test("falls back to config when env unset", async () => {
    const { writeConfig } = await freshConfig();
    writeConfig({ ownerAddress: OWNER_CFG });
    (await freshConfig())._resetConfigCache();
    const { getUserPrimaryEOA } = await import("../src/lib/arkiv-client.ts");
    expect(getUserPrimaryEOA().toLowerCase()).toBe(OWNER_CFG);
  });

  test("derives from CORTEX_USER_PRIVATE_KEY when neither env addr nor config", async () => {
    const pk = generatePrivateKey();
    const expected = privateKeyToAccount(pk).address.toLowerCase();
    process.env.CORTEX_USER_PRIVATE_KEY = pk;
    await freshConfig();
    const { getUserPrimaryEOA } = await import("../src/lib/arkiv-client.ts");
    expect(getUserPrimaryEOA().toLowerCase()).toBe(expected);
  });

  test("throws when nothing resolves", async () => {
    await freshConfig();
    const { getUserPrimaryEOA } = await import("../src/lib/arkiv-client.ts");
    expect(() => getUserPrimaryEOA()).toThrow();
  });
});

describe("owner resolution via owner-identity.getEffective (CURRENT GAP: env-only)", () => {
  test("resolves owner from env", async () => {
    process.env.USER_PRIMARY_ADDRESS = OWNER_ENV;
    const { _resetOwnerIdentity, getEffective } = await import("../src/agent/owner-identity.ts");
    _resetOwnerIdentity();
    expect((await getEffective()).ownerAddress?.toLowerCase()).toBe(OWNER_ENV);
    _resetOwnerIdentity();
  });

  test("FIXED (Task 6): ownerAddress falls back to config when env unset", async () => {
    const { writeConfig } = await freshConfig();
    writeConfig({ ownerAddress: OWNER_CFG });
    (await freshConfig())._resetConfigCache();
    const { _resetOwnerIdentity, getEffective } = await import("../src/agent/owner-identity.ts");
    _resetOwnerIdentity();
    // Task 6: owner address now resolves from ~/.cortex/config.json.
    expect((await getEffective()).ownerAddress?.toLowerCase()).toBe(OWNER_CFG);
    _resetOwnerIdentity();
  });
});

describe("session key resolution via arkiv-client.getWalletClient", () => {
  test("env wins over config", async () => {
    process.env.SESSION_KEY_PRIVATE_KEY = SK_ENV;
    const { writeConfig } = await freshConfig();
    writeConfig({ sessionKeyPrivate: SK_CFG });
    (await freshConfig())._resetConfigCache();
    await freshArkivClients();
    const { getSessionKeyAddress } = await import("../src/lib/arkiv-client.ts");
    const envAddr = privateKeyToAccount(SK_ENV as `0x${string}`).address.toLowerCase();
    expect(getSessionKeyAddress().toLowerCase()).toBe(envAddr);
  });

  test("falls back to config when env unset", async () => {
    const { writeConfig } = await freshConfig();
    writeConfig({ sessionKeyPrivate: SK_CFG });
    (await freshConfig())._resetConfigCache();
    await freshArkivClients();
    const { getSessionKeyAddress } = await import("../src/lib/arkiv-client.ts");
    const cfgAddr = privateKeyToAccount(SK_CFG as `0x${string}`).address.toLowerCase();
    expect(getSessionKeyAddress().toLowerCase()).toBe(cfgAddr);
  });
});

describe("signature resolution via payload-key.getPayloadKey", () => {
  test("env CORTEX_USER_SIGNATURE yields a key", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const sig = await account.signMessage({ message: keyDerivationMessage(account.address) });
    process.env.CORTEX_USER_SIGNATURE = sig;
    const { _resetOwnerIdentity } = await import("../src/agent/owner-identity.ts");
    _resetOwnerIdentity();
    const { getPayloadKey, _resetPayloadKey } = await import("../src/lib/payload-key.ts");
    _resetPayloadKey();
    expect(await getPayloadKey()).not.toBeNull();
    _resetPayloadKey();
    _resetOwnerIdentity();
  });

  test("falls back to config.userSignature when env unset", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const sig = await account.signMessage({ message: keyDerivationMessage(account.address) });
    const { writeConfig } = await freshConfig();
    writeConfig({ userSignature: sig });
    (await freshConfig())._resetConfigCache();
    const { _resetOwnerIdentity } = await import("../src/agent/owner-identity.ts");
    _resetOwnerIdentity();
    const { getPayloadKey, _resetPayloadKey } = await import("../src/lib/payload-key.ts");
    _resetPayloadKey();
    expect(await getPayloadKey()).not.toBeNull();
    _resetPayloadKey();
    _resetOwnerIdentity();
  });

  test("null when no signature anywhere", async () => {
    await freshConfig();
    const { _resetOwnerIdentity } = await import("../src/agent/owner-identity.ts");
    _resetOwnerIdentity();
    const { getPayloadKey, _resetPayloadKey } = await import("../src/lib/payload-key.ts");
    _resetPayloadKey();
    expect(await getPayloadKey()).toBeNull();
    _resetPayloadKey();
    _resetOwnerIdentity();
  });
});

describe("embeddings resolution via embeddings.hasEmbeddingKey", () => {
  const GOOD = "sk-test-abcdef0123456789"; // ≥16 chars, not a placeholder

  test("false when nothing set", async () => {
    await freshConfig();
    const { hasEmbeddingKey } = await import("../src/compression/embeddings.ts");
    expect(hasEmbeddingKey()).toBe(false);
  });

  test("true from env (any provider)", async () => {
    process.env.OPENROUTER_API_KEY = GOOD;
    await freshConfig();
    const { hasEmbeddingKey } = await import("../src/compression/embeddings.ts");
    expect(hasEmbeddingKey()).toBe(true);
  });

  test("falls back to config.embeddingKey", async () => {
    const { writeConfig } = await freshConfig();
    writeConfig({ embeddingKey: GOOD, embeddingProvider: "openai" });
    (await freshConfig())._resetConfigCache();
    const { hasEmbeddingKey } = await import("../src/compression/embeddings.ts");
    expect(hasEmbeddingKey()).toBe(true);
  });
});
