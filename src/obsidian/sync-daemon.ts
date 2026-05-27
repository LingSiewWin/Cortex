/**
 * Cortex — Obsidian ↔ Arkiv sync daemon (file-watch primary path).
 *
 * Per docs/obsidian/findings-repos.md §B, a headless Bun `fs.watch` daemon is the
 * primary bridge: it catches EVERY note change (agent, human, or sync), not just
 * the ones an MCP tool fires, and works with Obsidian closed. On each change we:
 *   parse → embed (whole-note + per-section) → createDocumentMemory (seals full
 *   text + embeddings into one sovereign Arkiv entity) → stamp the `cortex:`
 *   recovery block back into the file.
 *
 * Idempotency: if the body's sha-256 matches the `cortex.contentSha256` already
 * in the note, we SKIP — no embed call, no Arkiv write. This is what makes the
 * watcher safe to fire on every save (including our own stamp-back write).
 *
 * Conflict hygiene (findings-official-docs.md §3): we ignore dotfiles, non-`.md`,
 * and `*.sync-conflict*` files so Obsidian Sync / iCloud conflict copies don't
 * get sealed as if they were canonical.
 *
 * All I/O + network is injected via `deps` so the daemon is unit-testable with
 * in-memory fakes (see tests/obsidian-sync.test.ts).
 */

import { watch } from "node:fs";
import { readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { relative as pathRelative, basename, extname, isAbsolute, join } from "node:path";
import { embedText } from "../compression/embeddings.ts";
import {
  createDocumentMemory,
  type DocumentCreateInput,
  type DocumentCreateResult,
} from "../lib/batch-writer.ts";
import {
  parseNote,
  splitSections,
  contentSha256,
  stampCortexBlock,
  type CortexBlock,
} from "./note.ts";
import type { DocumentSectionInput } from "../compression/document-payload.ts";

// ---------------------------------------------------------------------------
// Injectable dependencies (real impls by default; fakes in tests).
// ---------------------------------------------------------------------------

export interface SyncDeps {
  /** Read a file as UTF-8 text. */
  readFile: (absPath: string) => Promise<string>;
  /** Write UTF-8 text to a file. */
  writeFile: (absPath: string, data: string) => Promise<void>;
  /** Text → 1536-d embedding. */
  embed: (text: string) => Promise<Float32Array>;
  /** Seal full text + embeddings into one Arkiv document entity. */
  createDocument: (input: DocumentCreateInput) => Promise<DocumentCreateResult>;
  /** Wall clock — injectable so tests get deterministic `updatedAt`. */
  now: () => Date;
}

const realDeps: SyncDeps = {
  readFile: (p) => fsReadFile(p, "utf8"),
  writeFile: (p, d) => fsWriteFile(p, d, "utf8"),
  embed: embedText,
  createDocument: createDocumentMemory,
  now: () => new Date(),
};

function resolveDeps(deps?: Partial<SyncDeps>): SyncDeps {
  return { ...realDeps, ...(deps ?? {}) };
}

// ---------------------------------------------------------------------------
// Single-file sync
// ---------------------------------------------------------------------------

export interface SyncResult {
  skipped?: boolean;
  entityKey?: string;
  txHash?: string;
  docId?: string;
  /** Why it was skipped, for daemon logging. */
  reason?: string;
}

export interface SyncNoteOptions {
  /** Vault root, so the sealed `vaultPath` is relative (recovery-friendly). */
  vaultPath?: string;
}

/**
 * Sync one note file to Arkiv. Idempotent: returns `{ skipped: true }` when the
 * body is unchanged since the last seal (sha matches the in-note cortex block).
 *
 * On a real change: embeds the whole note + each section, seals via
 * createDocumentMemory, then stamps the cortex recovery block back into the
 * file (docId, arkivEntityKey, contentSha256, updatedAt).
 */
export async function syncNoteFile(
  absPath: string,
  deps?: Partial<SyncDeps>,
  opts?: SyncNoteOptions,
): Promise<SyncResult> {
  const d = resolveDeps(deps);
  const raw = await d.readFile(absPath);
  const parsed = parseNote(raw);
  const body = parsed.body;

  if (body.trim().length === 0) {
    return { skipped: true, reason: "empty-body" };
  }

  const sha = await contentSha256(body);

  // Idempotent skip: the note already records a seal of this exact body.
  if (parsed.cortex?.contentSha256 === sha) {
    return { skipped: true, reason: "unchanged", docId: parsed.cortex.docId };
  }

  // Whole-note embedding (stage-2 rerank vector) + packed RaBitQ code inside
  // createDocumentMemory. We embed the FULL note text (frontmatter-stripped
  // body) so recall scores the human content, not YAML.
  const wholeEmbedding = await d.embed(body);

  // Per-section embeddings for passage-level recall granularity.
  const spans = splitSections(body);
  const sections: DocumentSectionInput[] = [];
  for (let i = 0; i < spans.length; i++) {
    const start = spans[i]!.offset;
    const end = i + 1 < spans.length ? spans[i + 1]!.offset : body.length;
    const sectionText = body.slice(start, end);
    if (sectionText.trim().length === 0) continue;
    const sectionEmbedding = await d.embed(sectionText);
    sections.push({
      heading: spans[i]!.heading,
      offset: start,
      embedding: sectionEmbedding,
    });
  }

  // Title: explicit frontmatter `title`, else the filename without extension.
  const fmTitle = parsed.frontmatter.title;
  const title =
    typeof fmTitle === "string" && fmTitle.trim().length > 0
      ? fmTitle
      : basename(absPath, extname(absPath));

  // vaultPath: relative to the vault root when provided, else the basename.
  const relPath = opts?.vaultPath
    ? pathRelative(opts.vaultPath, absPath)
    : basename(absPath);

  const input: DocumentCreateInput = {
    text: body,
    embedding: wholeEmbedding,
    sections,
    title,
    vaultPath: relPath,
    frontmatter: parsed.frontmatter,
    ...(parsed.cortex?.docId ? { docId: parsed.cortex.docId } : {}),
  };

  const result = await d.createDocument(input);

  // Stamp the recovery block back. We re-read is NOT needed: stamp the raw we
  // already hold (the body hasn't changed underneath us between read + seal in
  // the common case; the debounce guards against rapid re-saves).
  const cortexFields: CortexBlock = {
    docId: result.docId,
    vaultPath: relPath,
    contentSha256: result.contentSha256,
    arkivEntityKey: result.entityKey,
    tier: "rule",
    updatedAt: d.now().toISOString(),
  };
  const stamped = stampCortexBlock(raw, cortexFields);
  await d.writeFile(absPath, stamped);

  return {
    entityKey: result.entityKey,
    txHash: result.txHash,
    docId: result.docId,
  };
}

// ---------------------------------------------------------------------------
// Vault watcher
// ---------------------------------------------------------------------------

export interface VaultDaemonOptions {
  vaultPath: string;
  deps?: Partial<SyncDeps>;
  /** Per-file debounce window (ms). Default 800ms. */
  debounceMs?: number;
  /** Log sink (default console.log). Injectable for tests/quiet mode. */
  log?: (...args: unknown[]) => void;
  /** Error sink (default console.warn). */
  onError?: (err: unknown, absPath: string) => void;
}

export interface VaultDaemonHandle {
  stop: () => void;
}

/** True if a filename should be ignored (non-.md, dotfiles, sync conflicts). */
export function shouldIgnore(filename: string): boolean {
  const base = basename(filename);
  if (base.startsWith(".")) return true; // dotfiles + .obsidian/ internals
  if (extname(base).toLowerCase() !== ".md") return true;
  if (base.includes(".sync-conflict")) return true;
  return false;
}

/**
 * Start a recursive `fs.watch` on the vault. Per-file debounce coalesces the
 * burst of events an editor emits on a single save. Returns a handle with
 * `.stop()`.
 *
 * Editor "save" → multiple `change`/`rename` events; we debounce per absolute
 * path so we only sync once the file settles. Our own stamp-back write is
 * absorbed by the idempotent sha check in `syncNoteFile` (skips on unchanged).
 */
export function startVaultDaemon(opts: VaultDaemonOptions): VaultDaemonHandle {
  const { vaultPath } = opts;
  const debounceMs = opts.debounceMs ?? 800;
  const log = opts.log ?? ((...a: unknown[]) => console.log(...a));
  const onError =
    opts.onError ??
    ((err: unknown, p: string) =>
      console.warn(`[obsidian-sync] failed to sync ${p}:`, err));

  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const watcher = watch(vaultPath, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const name = filename.toString();
    if (shouldIgnore(name)) return;

    const absPath = isAbsolute(name) ? name : join(vaultPath, name);

    const existing = timers.get(absPath);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      timers.delete(absPath);
      void syncNoteFile(absPath, opts.deps, { vaultPath })
        .then((res) => {
          if (res.skipped) {
            log(`[obsidian-sync] skip ${absPath} (${res.reason})`);
          } else {
            log(
              `[obsidian-sync] sealed ${absPath} → ${res.entityKey} (tx ${res.txHash})`,
            );
          }
        })
        .catch((err) => onError(err, absPath));
    }, debounceMs);

    timers.set(absPath, timer);
  });

  log(`[obsidian-sync] watching vault ${vaultPath} (debounce ${debounceMs}ms)`);

  return {
    stop: () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      watcher.close();
      log(`[obsidian-sync] stopped watching ${vaultPath}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Runnable entrypoint — `bun run src/obsidian/sync-daemon.ts`
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const vaultPath = process.env.CORTEX_VAULT_PATH;
  if (!vaultPath) {
    console.error(
      "CORTEX_VAULT_PATH missing. Set it to your Obsidian vault root, e.g.\n" +
        "  CORTEX_VAULT_PATH=~/Vault bun run src/obsidian/sync-daemon.ts",
    );
    process.exit(1);
  }
  const handle = startVaultDaemon({ vaultPath });
  // Keep the process alive until SIGINT/SIGTERM, then stop cleanly.
  const shutdown = () => {
    handle.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Park forever.
  await new Promise<void>(() => {});
}

if (import.meta.main) {
  void main();
}
