/**
 * Cortex — embedding-key guard (Option D).
 *
 * Locks the "no API key → polished, friendly, actionable error" contract:
 * `embedText` throws a `MissingEmbeddingKeyError` whose message tells the user
 * exactly where to drop a key, and `isMissingEmbeddingKey` detects it so the
 * MCP tools / capture hook can treat it as setup (not a crash) and not retry.
 *
 * RaBitQ stays at 1536-d (untouched) — this is purely the provider-gate.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  embedText,
  isMissingEmbeddingKey,
  hasEmbeddingKey,
  MissingEmbeddingKeyError,
  EMBEDDING_SETUP_MESSAGE,
} from "../src/compression/embeddings.ts";
import { _resetConfigCache } from "../src/lib/cortex-config.ts";

const KEYS = ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "VOYAGE_API_KEY", "COHERE_API_KEY"] as const;
let saved: Record<string, string | undefined> = {};
let savedConfigPath: string | undefined;

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  // hasEmbeddingKey() now also reads ~/.cortex/config.json — point it at a
  // nonexistent path so this test stays hermetic regardless of the real machine.
  savedConfigPath = process.env.CORTEX_CONFIG_PATH;
  process.env.CORTEX_CONFIG_PATH = "/nonexistent/cortex-test-config.json";
  _resetConfigCache(); // read the nonexistent path fresh (no leaked memo from other tests)
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  if (savedConfigPath === undefined) delete process.env.CORTEX_CONFIG_PATH;
  else process.env.CORTEX_CONFIG_PATH = savedConfigPath;
});

test("no key → throws MissingEmbeddingKeyError with an actionable message", async () => {
  expect(hasEmbeddingKey()).toBe(false);
  let caught: unknown;
  try {
    await embedText("a memory worth keeping");
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(MissingEmbeddingKeyError);
  expect(isMissingEmbeddingKey(caught)).toBe(true);
  // The message names the exact env vars + where to get a key.
  const msg = (caught as Error).message;
  expect(msg).toContain("OPENAI_API_KEY");
  expect(msg).toContain("platform.openai.com");
  // Voyage (the Claude/Anthropic-ecosystem path) is named, with the honest note.
  expect(msg).toContain("VOYAGE_API_KEY");
  expect(msg).toContain("Anthropic has no embeddings");
  expect(msg).toBe(EMBEDDING_SETUP_MESSAGE);
});

test("any one key present → hasEmbeddingKey true (no throw on the gate)", () => {
  process.env.OPENAI_API_KEY = "sk-test";
  expect(hasEmbeddingKey()).toBe(true);
});

test("isMissingEmbeddingKey is false for ordinary errors", () => {
  expect(isMissingEmbeddingKey(new Error("network down"))).toBe(false);
  expect(isMissingEmbeddingKey(null)).toBe(false);
});
