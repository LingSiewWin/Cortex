#!/usr/bin/env bun
/**
 * Cortex — Claude Code capture hook (PreCompact / SessionEnd / Stop).
 *
 * Wired by cortex-plugin/hooks/hooks.json. Claude Code pipes a JSON event on
 * stdin:
 *   { session_id, transcript_path, cwd, hook_event_name, source? }
 *
 * `transcript_path` is a plaintext JSONL of the whole conversation. We:
 *   1. resolve a stable project id from the repo (`git remote get-url origin`
 *      of `cwd`, fallback to the cwd basename),
 *   2. read the transcript JSONL and deterministically extract user goals +
 *      assistant decisions into a concise summary (NO LLM call — hooks must be
 *      fast/offline; `PreCompact` cannot block/delay compaction),
 *   3. ALWAYS write the summary to a local pending file (atomic) under the plugin
 *      data dir, then hand the slow Arkiv write to a DETACHED background drainer
 *      (scripts/cortex-drain.ts) and exit 0 — never an inline chain write, since
 *      `PreCompact` cannot block/delay compaction. The drainer owns retries; the
 *      SessionStart hook also re-kicks it, so a queued summary is never lost.
 *
 * Invariant: this process NEVER throws and ALWAYS exits 0. A capture hook that
 * hangs or crashes would degrade the user's coding session — capture is
 * best-effort by design (local-mirror-first, retry on next SessionStart).
 */

import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { resolveProject } from "../src/lib/project-identity.ts";

// --- hook contract ---------------------------------------------------------

interface HookEvent {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  /** SessionStart/PreCompact carry a source (startup|resume|clear|compact|manual|auto). */
  source?: string;
}

/** Cap how much transcript we parse so a huge JSONL can't blow up the hook. */
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const MAX_SUMMARY_CHARS = 6_000;

// --- stdin -----------------------------------------------------------------

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Uint8Array);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

// Project identity is resolved by the shared src/lib/project-identity.ts module
// so capture (which stamps `workspace`) and recall (which queries by it) can
// never drift — see that file's header.

// --- transcript → summary (deterministic, offline) -------------------------

interface TranscriptMsg {
  role: "user" | "assistant";
  text: string;
}

/**
 * Parse the Claude Code transcript JSONL into ordered user/assistant text.
 * The format is one JSON object per line; assistant/user messages live under
 * `.message.content` which is either a string or an array of blocks with
 * `{ type: "text", text }`. We tolerate unknown shapes (skip silently).
 */
function parseTranscript(raw: string): TranscriptMsg[] {
  const out: TranscriptMsg[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    const rec = obj as Record<string, unknown>;
    const msg = (rec.message ?? rec) as Record<string, unknown>;
    const role = msg.role ?? rec.type;
    if (role !== "user" && role !== "assistant") continue;
    const text = extractText(msg.content);
    if (text) out.push({ role: role as "user" | "assistant", text });
  }
  return out;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block);
      } else if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
      }
    }
    return parts.join("\n").trim();
  }
  return "";
}

/** Decision-signalling cues used to lift assistant lines into the summary. */
const DECISION_CUES =
  /\b(decided|chose|chosen|will use|going with|approach|because|instead of|root cause|fix(?:ed)?|implement(?:ed)?|the plan|next step|conclusion|trade-?off|settled on)\b/i;

/**
 * Build a concise, structured summary from the transcript. Deterministic
 * extraction only — DO NOT call an LLM here (the hook must stay fast/offline).
 *
 * Shape (so next-session recall reads cleanly):
 *   # Session <id> — <project>
 *   ## Goals (what the user asked)
 *   - ...
 *   ## Decisions & outcomes (what the assistant did)
 *   - ...
 */
interface BuiltSummary {
  /** The rendered markdown summary. */
  text: string;
  /**
   * True when the transcript yielded at least one real goal or decision.
   * When false, the summary is just the boilerplate header + "(no clear …
   * extracted)" placeholders and is NOT worth a sealed chain write — capture
   * skips it instead of paying gas to store an empty husk (recon GAP 3).
   */
  meaningful: boolean;
}

function buildSummary(
  msgs: TranscriptMsg[],
  project: string,
  sessionId: string,
): BuiltSummary {
  const userTurns = msgs.filter((m) => m.role === "user");
  const asstTurns = msgs.filter((m) => m.role === "assistant");

  const goals = dedupeShort(
    userTurns
      .map((m) => firstMeaningfulLine(m.text))
      .filter((s): s is string => Boolean(s)),
    8,
  );

  // Assistant "decisions": prefer lines hitting a decision cue; fall back to
  // the first line of each assistant turn so we never emit an empty section.
  const decisionLines: string[] = [];
  for (const m of asstTurns) {
    for (const line of m.text.split("\n")) {
      const s = line.trim();
      if (s.length < 12) continue;
      if (DECISION_CUES.test(s)) decisionLines.push(s);
    }
  }
  let decisions = dedupeShort(decisionLines, 12);
  if (decisions.length === 0) {
    decisions = dedupeShort(
      asstTurns.map((m) => firstMeaningfulLine(m.text)).filter((s): s is string => Boolean(s)),
      8,
    );
  }

  const lines: string[] = [];
  lines.push(`# Session ${sessionId} — ${project}`);
  lines.push("");
  lines.push(`Captured ${new Date().toISOString()} · ${userTurns.length} user / ${asstTurns.length} assistant turns.`);
  lines.push("");
  lines.push("## Goals (what the user asked)");
  if (goals.length) for (const g of goals) lines.push(`- ${g}`);
  else lines.push("- (no clear user goals extracted)");
  lines.push("");
  lines.push("## Decisions & outcomes (what the assistant did)");
  if (decisions.length) for (const d of decisions) lines.push(`- ${d}`);
  else lines.push("- (no clear decisions extracted)");

  let summary = lines.join("\n");
  if (summary.length > MAX_SUMMARY_CHARS) {
    summary = summary.slice(0, MAX_SUMMARY_CHARS) + "\n…(truncated)";
  }
  return { text: summary, meaningful: goals.length > 0 || decisions.length > 0 };
}

function firstMeaningfulLine(text: string): string | null {
  for (const raw of text.split("\n")) {
    const s = raw.trim().replace(/\s+/g, " ");
    // Skip slash-commands, fenced code openers, and markup noise (closing tags,
    // comments/doctypes) — but NOT real content that opens with a tag like
    // "<Component> should …" or "<div> renders …", which a frontend-heavy session
    // legitimately uses as a goal (over-broad "<" dropped those and could empty
    // the whole summary — recon B2).
    if (!s || s.startsWith("/") || s.startsWith("```") || s.startsWith("</") || s.startsWith("<!")) continue;
    if (s.length < 4) continue;
    return s.length > 240 ? s.slice(0, 240) + "…" : s;
  }
  return null;
}

function dedupeShort(items: string[], limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    const key = it.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
    if (out.length >= limit) break;
  }
  return out;
}

// --- pending-queue fallback ------------------------------------------------

/** Plugin data dir — survives across sessions; the SessionStart hook drains it. */
function dataDir(): string {
  const base =
    process.env.CORTEX_PLUGIN_DATA_DIR ??
    join(homedir(), ".cortex", "plugin");
  const pending = join(base, "pending");
  mkdirSync(pending, { recursive: true });
  return pending;
}

interface PendingSummary {
  summary: string;
  sessionId: string;
  project: string;
  title: string;
  queuedAt: string;
  reason: string;
  event: string;
}

function queuePending(p: PendingSummary): string {
  const dir = dataDir();
  // safeName collapses every non-alnum to `_` and truncates, so two distinct raw
  // projects ("a/b" vs "a_b", or long monorepo paths differing past char 120)
  // could sanitize to the SAME name and silently overwrite each other (recon B1).
  // Disambiguate with a short hash of the RAW project+sessionId. The same
  // (project, sessionId) still maps to one file, so a re-capture of the same
  // session overwrites itself (idempotent), but different sessions never collide.
  const tag = createHash("sha1").update(`${p.project}\0${p.sessionId}`).digest("hex").slice(0, 8);
  const file = join(dir, `${safeName(p.project)}__${safeName(p.sessionId)}__${tag}.json`);
  // Atomic write: serialize to a temp file in the same dir, then rename over the
  // target. rename(2) is atomic within a filesystem, so the SessionStart drainer
  // (a separate, possibly concurrent process) only ever sees a fully-written
  // file — never a torn read mid-write (recon GAP 2). A repeated capture for the
  // same session deliberately overwrites with the fresher summary.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(p, null, 2), "utf-8");
  renameSync(tmp, file);
  return file;
}

function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120) || "x";
}

// --- main ------------------------------------------------------------------

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error("cortex-capture timeout")), ms)),
  ]);
}

async function main(): Promise<void> {
  let event: HookEvent = {};
  try {
    const stdin = await withTimeout(readStdin(), 2_000);
    if (stdin.trim()) event = JSON.parse(stdin) as HookEvent;
  } catch (err) {
    log("could not read/parse stdin event:", err);
    return; // exit 0
  }

  const cwd = event.cwd || process.cwd();
  const sessionId = event.session_id || `nosession-${Date.now()}`;
  const eventName = event.hook_event_name || "unknown";
  const project = resolveProject(cwd);
  const title = `Session summary — ${eventName} — ${sessionId}`;

  // Build the summary from the transcript (deterministic, offline).
  let summary = "";
  let meaningful = false;
  try {
    const path = event.transcript_path;
    if (path && existsSync(path)) {
      let raw = readFileSync(path, "utf-8");
      if (raw.length > MAX_TRANSCRIPT_BYTES) raw = raw.slice(-MAX_TRANSCRIPT_BYTES);
      const msgs = parseTranscript(raw);
      const built = buildSummary(msgs, project, sessionId);
      summary = built.text;
      meaningful = built.meaningful;
    } else {
      log(`transcript_path missing or not found: ${path}`);
    }
  } catch (err) {
    log("transcript parse failed:", err);
  }

  if (!summary.trim() || !meaningful) {
    // Either no summary, or only boilerplate with no extracted goal/decision —
    // not worth a sealed chain write. Exit cleanly without queuing an empty husk
    // (recon GAP 3: empty summaries were silently queued + written).
    log(
      `no meaningful summary for project=${project} session=${sessionId}; nothing to capture.`,
    );
    return;
  }

  // Decouple the chain write from the hook. A Braga write is ~10-16s (embed +
  // mutateEntities + read-after-write lag) — a hook must NEVER block the session
  // that long, and PreCompact cannot delay compaction. So we ALWAYS queue the
  // summary locally (instant) and hand the slow write to a DETACHED background
  // drainer (scripts/cortex-drain.ts) that owns retries with no hook timeout.
  // This is the fix for the "queue never drains" gap: the drain no longer runs
  // inside a 4-8s hook budget.
  const file = queuePending({
    summary,
    sessionId,
    project,
    title,
    queuedAt: new Date().toISOString(),
    reason: "queued for background drain",
    event: eventName,
  });
  log(`queued session summary: ${file} (project=${project} session=${sessionId})`);

  // Friendly up-front setup nudge: the write needs an embedding key. We still
  // queued the summary (nothing is lost — it syncs the moment a key exists), but
  // tell the user exactly what to do instead of letting it silently never sync.
  try {
    const { hasEmbeddingKey, EMBEDDING_SETUP_MESSAGE } = await import(
      "../src/compression/embeddings.ts"
    );
    if (!hasEmbeddingKey()) {
      log(`\nCortex: session memory queued, but not yet synced to Arkiv.\n${EMBEDDING_SETUP_MESSAGE}\n`);
      return; // don't spawn a drainer that will only hit the same missing-key wall
    }
  } catch {
    /* if the check itself fails, fall through and let the drainer try */
  }

  spawnDetachedDrain(project);
}

/**
 * Fire-and-forget a background drainer for this project, fully detached so it
 * outlives this hook (which exits immediately). The drainer writes the queued
 * summary to Arkiv with generous timeouts + retries. stdio ignored + unref so
 * the hook never waits on it.
 */
function spawnDetachedDrain(project: string): void {
  try {
    // Bundled standalone plugin → sibling is cortex-drain.js; dev → cortex-drain.ts.
    const here = import.meta.dir;
    const bundled = join(here, "cortex-drain.js");
    const drainScript = existsSync(bundled) ? bundled : join(here, "cortex-drain.ts");
    const child = spawn("bun", [drainScript, project], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch (err) {
    log("could not spawn background drainer (summary stays queued for next session):", err);
  }
}

/** Diagnostics go to stderr; a capture hook's stdout is not injected as context. */
function log(...args: unknown[]): void {
  console.error("[cortex/capture]", ...args);
}

// Top-level guard: under no circumstances should this hook exit non-zero.
main()
  .catch((err) => log("unexpected error (ignored):", err))
  .finally(() => process.exit(0));
