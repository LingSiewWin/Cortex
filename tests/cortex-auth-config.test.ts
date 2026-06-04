/**
 * Cortex — cortex auth config + canonical-signature + env→config fallback.
 *
 * Covers the load-bearing correctness the spec review flagged:
 *  - config round-trips (atomic 0600 write → read),
 *  - the canonical-message signature verification the auth callback relies on
 *    (sign keyDerivationMessage(addr) → recoverMessageAddress === addr): if this
 *    drifts, the derived encryption key silently mismatches at recall,
 *  - the env→config fallback in the consumers (env wins; else config; else error).
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { recoverMessageAddress } from "viem";
import { keyDerivationMessage } from "../src/lib/crypto.ts";

let dir: string;
const SECRET_ENVS = [
  "CORTEX_USER_SIGNATURE",
  "CORTEX_USER_PRIVATE_KEY",
  "USER_PRIMARY_ADDRESS",
  "SESSION_KEY_PRIVATE_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "VOYAGE_API_KEY",
  "COHERE_API_KEY",
];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cortex-cfg-"));
  process.env.CORTEX_CONFIG_PATH = join(dir, "config.json");
  savedEnv = {};
  for (const k of SECRET_ENVS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  delete process.env.CORTEX_CONFIG_PATH;
  for (const k of SECRET_ENVS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

test("config write → read round-trips, file is 0600", async () => {
  const { writeConfig, readConfig, _resetConfigCache } = await import("../src/lib/cortex-config.ts");
  writeConfig({
    ownerAddress: "0xabc",
    sessionKeyPrivate: "0xdef",
    userSignature: "0x123",
    embeddingKey: "sk-test",
    embeddingProvider: "voyage",
  });
  _resetConfigCache();
  const c = readConfig();
  expect(c?.version).toBe(1);
  expect(c?.ownerAddress).toBe("0xabc");
  expect(c?.embeddingProvider).toBe("voyage");
  expect(c?.createdAt).toBeTruthy();
  // 0600 = owner rw only.
  const mode = statSync(process.env.CORTEX_CONFIG_PATH!).mode & 0o777;
  expect(mode).toBe(0o600);
});

test("canonical-message signature verifies (the auth callback's real check)", async () => {
  // A wallet signs the EXACT message the page builds; the callback recovers it.
  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);
  const message = keyDerivationMessage(account.address);
  const signature = await account.signMessage({ message });

  const recovered = await recoverMessageAddress({ message, signature });
  expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());

  // And a DIFFERENT message must NOT recover to the address (drift = silent key mismatch).
  const wrong = await recoverMessageAddress({ message: "different text", signature });
  expect(wrong.toLowerCase()).not.toBe(account.address.toLowerCase());
});

test("env→config fallback: getUserPrimaryEOA reads config.ownerAddress when env unset", async () => {
  const { writeConfig, _resetConfigCache } = await import("../src/lib/cortex-config.ts");
  const owner = "0x1234567890123456789012345678901234567890";
  writeConfig({ ownerAddress: owner });
  _resetConfigCache();
  const { getUserPrimaryEOA } = await import("../src/lib/arkiv-client.ts");
  expect(getUserPrimaryEOA().toLowerCase()).toBe(owner);
});

test("env→config fallback: payload key derives from config.userSignature", async () => {
  // Produce a real signature so derivePayloadKey accepts it.
  const account = privateKeyToAccount(generatePrivateKey());
  const sig = await account.signMessage({ message: keyDerivationMessage(account.address) });
  const { writeConfig, _resetConfigCache } = await import("../src/lib/cortex-config.ts");
  writeConfig({ ownerAddress: account.address, userSignature: sig });
  _resetConfigCache();
  const { getPayloadKey, _resetPayloadKey } = await import("../src/lib/payload-key.ts");
  _resetPayloadKey();
  const key = await getPayloadKey();
  expect(key).not.toBeNull();
  _resetPayloadKey();
});

test("env→config fallback: hasEmbeddingKey true from config", async () => {
  const { writeConfig, _resetConfigCache } = await import("../src/lib/cortex-config.ts");
  const { hasEmbeddingKey } = await import("../src/compression/embeddings.ts");
  expect(hasEmbeddingKey()).toBe(false); // nothing set yet
  // Key must be ≥16 chars and not a placeholder to pass isUsableEmbeddingKey.
  writeConfig({ embeddingKey: "sk-test-abcdef0123456789", embeddingProvider: "openai" });
  _resetConfigCache();
  expect(hasEmbeddingKey()).toBe(true);
});
