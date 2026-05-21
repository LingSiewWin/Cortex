/**
 * Cortex — mirror backfill.
 *
 * Cold-start replay of historical Arkiv events into the SQLite mirror.
 *
 *   Run: bun scripts/backfill.ts
 *
 * Why this exists:
 *   The README and CLAUDE.md describe a self-host story where anyone can
 *   rebuild Cortex state from chain events. But `mirror/daemon.ts` starts from
 *   the current head on first run with no backfill — so a cold mirror misses
 *   every Cortex entity created before it started. This script closes the gap.
 *
 * Scan width:
 *   BACKFILL_BLOCKS env (default 5000) — same window mentioned in
 *   docs/Arkiv.md §1.3. Braga's RPC may further cap getLogs ranges; we
 *   chunk the request so we never ask for the whole window in one shot.
 *
 * Replay path:
 *   Each decoded log is fed through the daemon's `handleLog` so there is
 *   exactly one place that translates an event into a mirror row. The event
 *   log is append-only and idempotent on (block, txHash, logIndex), and
 *   `entities` rows use ON CONFLICT upserts — running this script twice is
 *   safe.
 *
 * Resume cursor:
 *   We deliberately do NOT touch `daemon_state.last_processed_block` while
 *   backfilling backwards — the daemon owns that cursor and we don't want
 *   the live daemon to "skip ahead" because a backfill ran. `handleLog`
 *   does write the cursor on every event, so on first ever boot (no cursor)
 *   this will leave the cursor at the highest historical block seen. If you
 *   want a clean handoff to the daemon, run backfill BEFORE starting the
 *   daemon for the first time.
 */

import type { Hex } from "@arkiv-network/sdk";
import { decodeEventLog } from "viem";
import { initMirrorDb } from "../src/mirror/db";
import {
  ARKIV_EVENTS_ABI,
  drainHydrateQueue,
  handleLog,
  type RawLog,
} from "../src/mirror/daemon";
import { getPublicClient } from "../src/lib/arkiv-client";
import { BRAGA } from "../src/constants";

const DEFAULT_SCAN_WIDTH = 5000;
// Braga's eth_getLogs cap is undocumented but rejects ~2500-block requests.
// 500 is the same conservative ceiling we use in daemon.ts polling.
const CHUNK_SIZE = 500;

interface BackfillStats {
  scannedFromBlock: bigint;
  scannedToBlock: bigint;
  logsSeen: number;
  logsDecoded: number;
  logsApplied: number;
  errors: number;
}

async function main(): Promise<void> {
  const widthStr = process.env.BACKFILL_BLOCKS;
  const width = widthStr ? Number(widthStr) : DEFAULT_SCAN_WIDTH;
  if (!Number.isFinite(width) || width <= 0) {
    throw new Error(
      `BACKFILL_BLOCKS must be a positive integer, got ${widthStr}`,
    );
  }

  const db = await initMirrorDb();
  const publicClient = getPublicClient();
  const head = await publicClient.getBlockNumber();
  const fromBlock = head > BigInt(width) ? head - BigInt(width) : 0n;

  console.log(
    `[backfill] head=${head} scanning ${width} blocks ` +
      `[${fromBlock}..${head}] in chunks of ${CHUNK_SIZE}`,
  );

  const stats: BackfillStats = {
    scannedFromBlock: fromBlock,
    scannedToBlock: head,
    logsSeen: 0,
    logsDecoded: 0,
    logsApplied: 0,
    errors: 0,
  };

  const noop = (..._args: unknown[]): void => {};

  for (let chunkFrom = fromBlock; chunkFrom <= head; chunkFrom += BigInt(CHUNK_SIZE)) {
    const chunkTo =
      chunkFrom + BigInt(CHUNK_SIZE - 1) > head
        ? head
        : chunkFrom + BigInt(CHUNK_SIZE - 1);

    let logs: Awaited<ReturnType<typeof publicClient.getLogs>>;
    try {
      logs = await publicClient.getLogs({
        address: BRAGA.precompileAddress as Hex,
        events: ARKIV_EVENTS_ABI,
        fromBlock: chunkFrom,
        toBlock: chunkTo,
      });
    } catch (err) {
      console.error(
        `[backfill] getLogs failed for [${chunkFrom}..${chunkTo}]:`,
        err instanceof Error ? err.message : err,
      );
      stats.errors++;
      continue;
    }

    stats.logsSeen += logs.length;

    for (const lg of logs) {
      // Sanity-check the topic decodes — if not, skip and log.
      try {
        decodeEventLog({
          abi: ARKIV_EVENTS_ABI,
          topics: lg.topics as [Hex, ...Hex[]] | [],
          data: lg.data,
        });
        stats.logsDecoded++;
      } catch (err) {
        stats.errors++;
        console.error(
          `[backfill] decode failed @ block ${lg.blockNumber} tx ${lg.transactionHash}:`,
          err instanceof Error ? err.message : err,
        );
        continue;
      }

      const rawLog: RawLog = {
        blockNumber: lg.blockNumber,
        transactionHash: lg.transactionHash,
        logIndex: lg.logIndex,
        topics: lg.topics as readonly Hex[],
        data: lg.data,
      };

      try {
        handleLog(db, publicClient, rawLog, noop);
        stats.logsApplied++;
      } catch (err) {
        // Most likely cause: SQLite UNIQUE violation on (block,tx,logIndex) —
        // means this event was already mirrored. Tolerate it; backfill is
        // idempotent by design.
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("UNIQUE")) {
          // already mirrored, no-op
        } else {
          stats.errors++;
          console.error(
            `[backfill] handleLog failed @ block ${lg.blockNumber}:`,
            msg,
          );
        }
      }
    }
  }

  // handleLog schedules hydrations onto a shared queue (capped at 3 concurrent).
  // Backfill is synchronous-looking but hydrations are still flying — drain
  // before exit so we never terminate mid-RPC and lose work.
  console.log(`[backfill] draining hydrate queue…`);
  await drainHydrateQueue();

  console.log(
    `[backfill] done — seen=${stats.logsSeen} decoded=${stats.logsDecoded} ` +
      `applied=${stats.logsApplied} errors=${stats.errors} ` +
      `range=[${stats.scannedFromBlock}..${stats.scannedToBlock}]`,
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[backfill] fatal:", err);
    process.exit(1);
  });
}
