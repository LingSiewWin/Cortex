/**
 * Cortex — single source of truth for credential resolution.
 *
 * Every secret Cortex consumes (session key, owner EOA, encryption signature,
 * embedding key) resolves the SAME way: environment variable first, then the
 * `~/.cortex/config.json` that `cortex auth` writes. This module centralizes that
 * precedence so a fresh installer who ran `cortex auth` gets a working plugin
 * without exporting a single env var — and so the rule lives in one place instead
 * of being re-implemented (inconsistently) across arkiv-client, payload-key,
 * embeddings, owner-identity, and the MCP server.
 *
 * Design constraints (do not break):
 *  - PURE and SYNCHRONOUS. No network, no message signing, no key derivation.
 *    Returns RAW material; the async layers (signing a derivation message with
 *    CORTEX_USER_PRIVATE_KEY, deriving the AES key, browser adoption) stay in
 *    their existing modules and call this underneath.
 *  - Precedence is ALWAYS env → config. This matches every currently-working path;
 *    the only new behavior is owner falling back to config where it didn't before.
 *  - The `source` map records where each credential came from, for honest
 *    "what's missing / where it resolved" diagnostics.
 */

import { privateKeyToAccount } from "viem/accounts";
import { isUsableEmbeddingKey } from "../compression/embeddings.ts";
import { readConfig, type EmbeddingProvider } from "./cortex-config.ts";

export type CredSource = "env" | "config" | "derived" | "none";

export interface ResolvedCredentials {
  /** Session-key private key ($creator / Arkiv write signer). 0x + 64 hex. */
  sessionKeyPrivate: string | null;
  /** Owner EOA ($owner). Validated 0x + 40 hex (derived from CORTEX_USER_PRIVATE_KEY if needed). */
  ownerEOA: string | null;
  /** EIP-191 signature of the key-derivation message (seeds the encryption key). */
  userSignature: string | null;
  /** Dev-convenience primary private key (used to derive owner + sign in-process). 0x + 64 hex. */
  userPrivateKey: string | null;
  /** Embedding provider key + which provider it belongs to. */
  embedding: { key: string; provider: EmbeddingProvider } | null;
  /** Where each credential resolved from — for diagnostics, not control flow. */
  source: {
    sessionKey: CredSource;
    owner: CredSource;
    signature: CredSource;
    embedding: CredSource;
  };
}

const EOA_RE = /^0x[0-9a-fA-F]{40}$/;
const PK_RE = /^0x[0-9a-fA-F]{64}$/;
const SIG_RE = /^0x[0-9a-fA-F]+$/;

function validPk(v: string | undefined | null): string | null {
  return typeof v === "string" && PK_RE.test(v) ? v : null;
}
function validEoa(v: string | undefined | null): string | null {
  return typeof v === "string" && EOA_RE.test(v) ? v : null;
}
function validSig(v: string | undefined | null): string | null {
  return typeof v === "string" && SIG_RE.test(v) ? v : null;
}

/** Derive the owner address from a primary private key (the rare derive path). */
function deriveAddressFromPk(pk: string): string | null {
  try {
    return privateKeyToAccount(pk as `0x${string}`).address;
  } catch {
    return null;
  }
}

/** Resolve the embedding key from env (provider order) then config. */
function resolveEmbedding(): { value: { key: string; provider: EmbeddingProvider } | null; source: CredSource } {
  const envProviders: Array<[string, EmbeddingProvider]> = [
    ["OPENAI_API_KEY", "openai"],
    ["OPENROUTER_API_KEY", "openrouter"],
    ["VOYAGE_API_KEY", "voyage"],
    ["COHERE_API_KEY", "cohere"],
  ];
  for (const [envName, provider] of envProviders) {
    const v = process.env[envName];
    if (isUsableEmbeddingKey(v)) return { value: { key: v!.trim(), provider }, source: "env" };
  }
  const cfg = readConfig();
  if (cfg?.embeddingKey && isUsableEmbeddingKey(cfg.embeddingKey)) {
    // Default to "openai" when a key is present without an explicit provider,
    // matching embeddings.ts embedText() (`cfg.embeddingProvider ?? "openai"`).
    return {
      value: { key: cfg.embeddingKey.trim(), provider: cfg.embeddingProvider ?? "openai" },
      source: "config",
    };
  }
  return { value: null, source: "none" };
}

/**
 * Resolve every Cortex credential from env → `~/.cortex/config.json`, with a
 * `source` map. Pure + synchronous. Returns raw material; callers do their own
 * async derivation/signing.
 */
export function resolveCredentials(): ResolvedCredentials {
  const cfg = readConfig();

  // Session key: env → config.
  const skEnv = validPk(process.env.SESSION_KEY_PRIVATE_KEY);
  const skCfg = validPk(cfg?.sessionKeyPrivate);
  const sessionKeyPrivate = skEnv ?? skCfg;
  const sessionKeySource: CredSource = skEnv ? "env" : skCfg ? "config" : "none";

  // Dev primary private key (env only).
  const userPrivateKey = validPk(process.env.CORTEX_USER_PRIVATE_KEY);

  // Owner EOA: env addr → config addr → derive from primary private key.
  const ownerEnv = validEoa(process.env.USER_PRIMARY_ADDRESS);
  const ownerCfg = validEoa(cfg?.ownerAddress);
  let ownerEOA: string | null = ownerEnv ?? ownerCfg;
  let ownerSource: CredSource = ownerEnv ? "env" : ownerCfg ? "config" : "none";
  if (!ownerEOA && userPrivateKey) {
    const derived = deriveAddressFromPk(userPrivateKey);
    if (derived) {
      ownerEOA = derived;
      ownerSource = "derived";
    }
  }

  // Encryption signature: env → config.
  const sigEnv = validSig(process.env.CORTEX_USER_SIGNATURE);
  const sigCfg = validSig(cfg?.userSignature);
  const userSignature = sigEnv ?? sigCfg;
  const signatureSource: CredSource = sigEnv ? "env" : sigCfg ? "config" : "none";

  // Embedding key: env (provider order) → config.
  const emb = resolveEmbedding();

  return {
    sessionKeyPrivate,
    ownerEOA,
    userSignature,
    userPrivateKey,
    embedding: emb.value,
    source: {
      sessionKey: sessionKeySource,
      owner: ownerSource,
      signature: signatureSource,
      embedding: emb.source,
    },
  };
}
