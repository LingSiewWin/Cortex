/**
 * Cortex — local config file (`~/.cortex/config.json`).
 *
 * Written by `cortex auth` (the browser-wallet onboarding flow), read by the
 * plugin's secret consumers as a FALLBACK after their environment variables.
 *
 * Why a file and not just env: the plugin's hooks (cortex-plugin/hooks/hooks.json)
 * and MCP server (cortex-plugin/.mcp.json, `"env": {}`) are spawned by Claude Code
 * and inherit only the parent shell env — Cortex can't inject secrets into them.
 * A file the consumers read is the reliable channel. Env vars remain the override.
 *
 * Holds a hot session private key in plaintext (v1; OS-keychain is a future step),
 * so writes are atomic + mode 0600 (temp file created 0600, then renamed in).
 */

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";

export type EmbeddingProvider = "openai" | "openrouter" | "voyage" | "cohere";

export interface CortexConfig {
  version: number;
  /** User's wallet — the $owner / encryption root (USER_PRIMARY_ADDRESS fallback). */
  ownerAddress?: string;
  /** Generated hot key that signs Arkiv writes ($creator) — SESSION_KEY_PRIVATE_KEY fallback. */
  sessionKeyPrivate?: string;
  /** personal_sign of keyDerivationMessage → derives the encryption key (CORTEX_USER_SIGNATURE fallback). */
  userSignature?: string;
  /** Optional embedding API key — fallback for the provider env vars. */
  embeddingKey?: string;
  /** Which provider `embeddingKey` belongs to (maps to the right embedText branch). */
  embeddingProvider?: EmbeddingProvider;
  createdAt?: string;
}

const CONFIG_VERSION = 1;

/** Absolute path to the config file. Overridable via CORTEX_CONFIG_PATH (tests). */
export function configPath(): string {
  return process.env.CORTEX_CONFIG_PATH ?? join(homedir(), ".cortex", "config.json");
}

// Per-process memo so repeated fallbacks don't re-read the file. `cortex auth`
// runs in its own process, so there's no stale-across-processes concern.
let _cached: CortexConfig | null | undefined;

/**
 * Read the config, or `null` if absent/malformed. NEVER throws — a missing or
 * corrupt config must degrade to "no fallback", not crash the hook/recall path.
 */
export function readConfig(): CortexConfig | null {
  if (_cached !== undefined) return _cached;
  const path = configPath();
  try {
    if (!existsSync(path)) {
      _cached = null;
      return null;
    }
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as CortexConfig;
    _cached = parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    _cached = null;
  }
  return _cached;
}

/**
 * Atomically write the config with mode 0600. Creates `~/.cortex/` if needed.
 * Writes a temp file (created 0600) then renames over the target so there is no
 * window where a half-written or world-readable file exists.
 */
export function writeConfig(config: Omit<CortexConfig, "version" | "createdAt"> & Partial<Pick<CortexConfig, "createdAt">>): CortexConfig {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  const full: CortexConfig = {
    version: CONFIG_VERSION,
    createdAt: config.createdAt ?? new Date().toISOString(),
    ...config,
  };
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(full, null, 2), { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600); // belt-and-suspenders (umask can widen mode on some FS)
  } catch {
    /* best-effort */
  }
  renameSync(tmp, path);
  _cached = full;
  return full;
}

/** Test seam: clear the per-process memo so the next read re-loads from disk. */
export function _resetConfigCache(): void {
  _cached = undefined;
}
