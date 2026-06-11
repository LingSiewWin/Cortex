#!/usr/bin/env bun
/**
 * Cortex — Claude Code recall hook (SessionStart).
 *
 * Wired by cortex-plugin/hooks/hooks.json. Claude Code pipes a JSON event on
 * stdin:
 *   { session_id, transcript_path, cwd, hook_event_name, source? }
 *
 * SessionStart hooks may inject context into the session via STDOUT. We:
 *   1. resolve the project id (same logic as the capture hook),
 *   2. opportunistically drain any locally-queued summaries from prior sessions
 *      where the Arkiv write failed (best-effort retry — the "local-mirror-first,
 *      retry on next SessionStart" resilience),
 *   3. derive a recall query from the project + recent files in `cwd`,
 *   4. `recall({ query, k: 5, project })` and print a short
 *      "Cortex recalls for <project>:" block to stdout so the assistant starts
 *      the session already knowing what it learned before.
 *
 * Invariant: best-effort, never throws, ALWAYS exits 0. If recall fails (no
 * mirror, no wallet, etc.) we print nothing and exit cleanly — a SessionStart
 * hook must not block the user from working.
 */

import { readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { resolveProject } from "../src/lib/project-identity.ts";

interface HookEvent {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  source?: string;
}

const HOOK_BUDGET_MS = 8_000;
const RECALL_K = 5;

// --- stdin -----------------------------------------------------------------

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Uint8Array);
  return Buffer.concat(chunks).toString("utf-8");
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error("cortex-recall timeout")), ms)),
  ]);
}

// Project identity is resolved by the shared src/lib/project-identity.ts module
// so capture (which stamps the `workspace` provenance) and recall (which queries
// by it) can never drift — see that file's header.

// --- query derivation ------------------------------------------------------

/** Build a recall cue from the project + the names of recently-touched files. */
function deriveQuery(cwd: string, project: string): string {
  const recent = recentFiles(cwd, 8);
  const filePart = recent.length ? ` Recent files: ${recent.join(", ")}.` : "";
  return `Context, decisions, and gotchas for project ${project}.${filePart}`;
}

/** Recently-modified source files in the repo (cheap, depth-limited walk). */
function recentFiles(cwd: string, limit: number): string[] {
  const IGNORE = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    "coverage",
    ".cache",
  ]);
  const EXT = /\.(ts|tsx|js|jsx|py|rs|go|sol|md|json|css|html)$/i;
  const found: { name: string; mtime: number }[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 2 || found.length > 400) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.startsWith(".") && e !== ".") continue;
      if (IGNORE.has(e)) continue;
      const full = join(dir, e);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full, depth + 1);
      else if (EXT.test(e)) found.push({ name: e, mtime: st.mtimeMs });
    }
  };
  try {
    walk(cwd, 0);
  } catch {
    /* ignore */
  }
  found.sort((a, b) => b.mtime - a.mtime);
  const names: string[] = [];
  const seen = new Set<string>();
  for (const f of found) {
    if (seen.has(f.name)) continue;
    seen.add(f.name);
    names.push(f.name);
    if (names.length >= limit) break;
  }
  return names;
}

// --- pending-queue drain (best-effort retry) -------------------------------

function pendingDir(): string {
  const base = process.env.CORTEX_PLUGIN_DATA_DIR ?? join(homedir(), ".cortex", "plugin");
  return join(base, "pending");
}

/**
 * Kick a DETACHED background drainer for queued summaries from prior sessions
 * whose write hasn't landed yet. We do NOT drain inline — a Braga write is
 * ~10-16s and a SessionStart hook must not block the user that long (the old
 * inline 4s budget could never complete a single write, so the queue never
 * cleared). The detached drainer owns the slow write; this hook returns instantly.
 * Returns the count of items currently queued for this project (for the banner).
 */
function kickDrain(project: string): number {
  const dir = pendingDir();
  if (!existsSync(dir)) return 0;
  let queued = 0;
  try {
    queued = readdirSync(dir).filter((f) => f.endsWith(".json")).length;
  } catch {
    queued = 0;
  }
  if (queued === 0) return 0;
  try {
    const here = import.meta.dir;
    const bundled = join(here, "cortex-drain.js");
    const drainScript = existsSync(bundled) ? bundled : join(here, "cortex-drain.ts");
    const child = spawn("bun", [drainScript, project], { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    /* drainer will be retried on the next session */
  }
  return queued;
}

// --- main ------------------------------------------------------------------

async function main(): Promise<void> {
  let event: HookEvent = {};
  try {
    const stdin = await withTimeout(readStdin(), 2_000);
    if (stdin.trim()) event = JSON.parse(stdin) as HookEvent;
  } catch {
    return; // exit 0
  }

  const cwd = event.cwd || process.cwd();
  const project = resolveProject(cwd);

  // 1) Fire-and-forget a background drain of queued summaries (instant; the
  //    detached drainer owns the slow Arkiv write — we never block on it here).
  const queued = kickDrain(project);

  // 2) Recall this project's memory and inject as session context.
  try {
    const { recall } = await import("../src/darwinian/recall.ts");
    const query = deriveQuery(cwd, project);
    // Pass sessionId so resume/clear of an existing session re-surfaces that
    // session's own memories first (the 1.3x same-session continuity boost).
    // On a brand-new session id it's simply a no-op boost — harmless.
    const hits = await withTimeout(
      recall({
        query,
        k: RECALL_K,
        project,
        ...(event.session_id ? { sessionId: event.session_id } : {}),
      }),
      HOOK_BUDGET_MS,
    );

    if (!hits || hits.length === 0) {
      if (queued > 0) {
        process.stdout.write(
          `Cortex: syncing ${queued} queued memory write(s) for ${project} in the background. No prior memories surfaced yet.\n`,
        );
      }
      return;
    }

    const lines: string[] = [];
    lines.push(`Cortex recalls for ${project} (top ${hits.length}, decay-aware):`);
    for (const h of hits) {
      const preview = (h.text ?? h.payloadPreview ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200);
      lines.push(`- [${h.entityType}] ${preview || "(no preview)"}`);
    }
    lines.push(
      `(Use the cortex_recall / cortex_act MCP tools to pull full context and cite what you use — citing reinforces a memory's lease.)`,
    );
    if (queued > 0) lines.push(`(Syncing ${queued} queued summary write(s) from earlier sessions in the background.)`);
    process.stdout.write(lines.join("\n") + "\n");
  } catch (err) {
    // No mirror / no wallet / RPC down → stay silent (don't disrupt the session).
    console.error("[cortex/recall] recall skipped:", err instanceof Error ? err.message : err);
  }
}

main()
  .catch((err) => console.error("[cortex/recall] unexpected error (ignored):", err))
  .finally(() => process.exit(0));
