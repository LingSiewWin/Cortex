/**
 * Cortex — shared server bootstrap for Bun dashboard and Next.js runtime.
 *
 * Starts mirror-backed workers (autonomous loop, anchor drain, evict watcher)
 * once per process. Safe to call multiple times (idempotent guard).
 */

import { initMirrorDb } from "../mirror/db";
import { startSingletonLoop } from "../agent/loop-singleton";
import { startAnchorWorker, type AnchorWorkerHandle } from "../agent/anchor-worker";
import { sampleChainHead } from "../mirror/chain-health";
import { startEvictWatcher, type EvictWatcherHandle } from "../mirror/evict-watcher";
import { listMirroredEntities } from "../mirror/replay";

let _started = false;
let _anchorWorker: AnchorWorkerHandle | null = null;
let _evictWatcher: EvictWatcherHandle | null = null;

async function getCurrentBlockEstimate(): Promise<number> {
  const recent = await listMirroredEntities({ limit: 1 });
  if (recent.length === 0) return 0;
  return recent[0]!.lastEventBlock;
}

/** Initialise SQLite mirror schema (idempotent). */
export async function ensureMirrorDb(): Promise<void> {
  await initMirrorDb();
}

/** True when this process should open the SQLite mirror (not on default Vercel serverless). */
export function isMirrorEnabled(): boolean {
  if (process.env.CORTEX_MIRROR === "off") return false;
  if (process.env.VERCEL === "1" && process.env.CORTEX_START_WORKERS !== "1") {
    return false;
  }
  return true;
}

/** Start background workers once. No-op on Vercel unless CORTEX_START_WORKERS=1. */
export async function startCortexWorkers(): Promise<void> {
  if (_started) return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  _started = true;

  if (!isMirrorEnabled()) return;

  await ensureMirrorDb();

  if (process.env.CORTEX_AUTONOMOUS_LOOP !== "off") {
    try {
      startSingletonLoop();
    } catch {
      /* read-only / missing wallet */
    }
  }

  if (process.env.CORTEX_ANCHOR_WORKER !== "off") {
    try {
      _anchorWorker = startAnchorWorker({
        sampleHealth: () => sampleChainHead({ samples: 3, gapMs: 200 }),
      });
    } catch {
      /* non-fatal */
    }
  }

  if (process.env.CORTEX_EVICT_WATCHER !== "off") {
    try {
      _evictWatcher = await startEvictWatcher({
        deps: { currentBlock: getCurrentBlockEstimate },
      });
    } catch {
      /* non-fatal */
    }
  }
}
