#!/usr/bin/env bun
/**
 * Cortex — pending-queue drainer (the background writer).
 *
 * THE FIX for the capture gap: a Claude Code hook must never block the session,
 * so it can't sit ~10-16s waiting on a Braga write. Instead the capture hook
 * queues the summary locally (instant) and spawns THIS as a detached background
 * process. This drainer owns the slow chain write with NO hook-timeout pressure
 * and real retries (Braga write latency + read-after-write flakiness).
 *
 * Run modes:
 *   - spawned detached by cortex-hook-capture.ts (fire-and-forget after queue)
 *   - kicked by cortex-hook-recall.ts on SessionStart (retry insurance)
 *   - manually / cron:  bun run cortex-drain [projectFilter]
 *
 * A lock file prevents two drains racing on the same queue. Each item gets a
 * generous per-item timeout + a few retries; success deletes the local file,
 * failure leaves it for the next drain.
 */

import {
  readdirSync,
  readFileSync,
  unlinkSync,
  existsSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Generous — this is background work, not a hook. Covers embed + chain write + lag. */
const PER_ITEM_TIMEOUT_MS = 45_000;
const MAX_ATTEMPTS = 3;
const LOCK_STALE_MS = 180_000;

interface PendingSummary {
  summary: string;
  sessionId: string;
  project: string;
  title: string;
}

function pendingDir(): string {
  const base = process.env.CORTEX_PLUGIN_DATA_DIR ?? join(homedir(), ".cortex", "plugin");
  return join(base, "pending");
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error("drain item timeout")), ms)),
  ]);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function log(...a: unknown[]): void {
  console.error("[cortex/drain]", ...a);
}

async function main(): Promise<void> {
  const projectFilter = process.argv[2]; // optional: only drain this project
  const dir = pendingDir();
  if (!existsSync(dir)) return;

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return;
  }
  if (files.length === 0) return;

  // Lock: avoid two concurrent drains double-writing the same item.
  const lock = join(dir, ".drain.lock");
  if (existsSync(lock)) {
    try {
      if (Date.now() - statSync(lock).mtimeMs < LOCK_STALE_MS) {
        log("another drain holds the lock — exiting");
        return;
      }
    } catch {
      /* stat failed — treat as stale, take the lock */
    }
  }
  try {
    writeFileSync(lock, String(process.pid), "utf-8");
  } catch {
    return;
  }

  let drained = 0;
  let failed = 0;
  try {
    const { storeSessionSummary } = await import("../src/agent/session-summary.ts");
    const { isMissingEmbeddingKey } = await import("../src/compression/embeddings.ts");
    for (const f of files) {
      const full = join(dir, f);
      let item: PendingSummary;
      try {
        item = JSON.parse(readFileSync(full, "utf-8")) as PendingSummary;
      } catch {
        continue;
      }
      if (projectFilter && item.project !== projectFilter) continue;
      if (!item.summary || !item.sessionId) {
        // malformed — drop so it doesn't wedge the queue forever
        try {
          unlinkSync(full);
        } catch {
          /* ignore */
        }
        continue;
      }

      let ok = false;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS && !ok; attempt++) {
        try {
          const res = await withTimeout(
            storeSessionSummary({
              summary: item.summary,
              sessionId: item.sessionId,
              project: item.project,
              title: item.title,
            }),
            PER_ITEM_TIMEOUT_MS,
          );
          log(`drained ${f} → project=${item.project} tx=${res.txHash} entity=${res.entityKey}`);
          try {
            unlinkSync(full);
          } catch {
            /* ignore */
          }
          ok = true;
          drained++;
        } catch (err) {
          // Missing API key is NOT transient — don't burn retries or spin every
          // session. Log the friendly guidance once, leave the queue intact for
          // when the key is added, and stop this whole drain run.
          if (isMissingEmbeddingKey(err)) {
            log(
              `\n${err instanceof Error ? err.message : String(err)}\n\n` +
                `(${files.length} session memory(ies) are safely queued and will sync ` +
                `automatically once a key is set.)`,
            );
            failed++;
            return;
          }
          const msg = err instanceof Error ? err.message : String(err);
          log(`attempt ${attempt}/${MAX_ATTEMPTS} failed for ${f}: ${msg}`);
          if (attempt < MAX_ATTEMPTS) await sleep(2_000 * attempt);
        }
      }
      if (!ok) failed++;
    }
  } catch (err) {
    log("drainer fatal (queue left intact):", err instanceof Error ? err.message : err);
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      /* ignore */
    }
  }
  log(`done: ${drained} drained, ${failed} still queued.`);
}

main()
  .catch((err) => log("unexpected error (ignored):", err))
  .finally(() => process.exit(0));
