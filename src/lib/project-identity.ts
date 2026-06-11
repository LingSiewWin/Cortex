/**
 * Cortex — canonical project identity.
 *
 * A single source of truth for "which project/workspace does this cwd belong
 * to?". The capture hook (writes the memory's `workspace` provenance) and the
 * recall hook (queries by that same provenance) MUST agree byte-for-byte, or a
 * memory captured under one id is never recalled under another — a silent
 * cross-session data-loss bug. Previously each hook carried its own copy of this
 * logic; this module makes drift impossible by construction.
 *
 * Identity = `git remote get-url origin` of `cwd`, normalized to `host/owner/repo`;
 * fallback to the cwd basename for non-git projects. Pure + synchronous; the only
 * side effect is a short, sandboxed `git` invocation with a hard 2s timeout.
 */

import { execFileSync } from "node:child_process";
import { basename } from "node:path";

/**
 * `git@host:owner/repo.git` | `https://host/owner/repo.git` |
 * `ssh://git@host/owner/repo` → `host/owner/repo`.
 *
 * Exported so tests can pin every URL shape (scp, https, ssh, custom host/port,
 * trailing `.git`) against the exact normalization the hooks use.
 */
export function normalizeRemote(url: string): string | null {
  if (!url) return null;
  // Strip a single trailing `.git` (covers `repo.git` and `repo.git/`).
  let s = url.trim().replace(/\.git\/?$/, "");
  // scp-style: git@github.com:owner/repo. A real scp remote has NO `://` scheme;
  // guard on that so we don't misparse `ssh://host:port/owner/repo` (which has
  // both `@` and `:`) as scp and fold the port into the path.
  const scp = !s.includes("://") ? s.match(/^[^@]+@([^:]+):(.+)$/) : null;
  if (scp) return `${scp[1]}/${scp[2]}`.replace(/\/+$/, "");
  // url-style: https://github.com/owner/repo or ssh://git@host/owner/repo
  try {
    const u = new URL(s);
    const path = u.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
    if (u.hostname && path) return `${u.hostname}/${path}`;
  } catch {
    /* not a URL — fall through */
  }
  const trimmed = s.replace(/\/+$/, "");
  return trimmed || null;
}

/**
 * Resolve a stable project id for `cwd`. Tries the git origin remote first
 * (normalized), then falls back to the directory basename, then to a constant so
 * the result is never empty. Never throws.
 */
export function resolveProject(cwd: string): string {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    })
      .toString()
      .trim();
    const norm = normalizeRemote(url);
    if (norm) return norm;
  } catch {
    /* not a git repo, no origin, or git missing — fall through */
  }
  try {
    return basename(cwd) || "unknown-project";
  } catch {
    return "unknown-project";
  }
}
