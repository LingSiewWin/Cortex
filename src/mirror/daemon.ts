/**
 * Cortex — mirror daemon.
 *
 * Subscribes to Arkiv events via the SDK's polling subscription. For each event:
 *   1. Append raw event to the events table (append-only, never mutated).
 *   2. If entity is known-Cortex (or unknown and event is create), fetch full state
 *      via getEntity and reconcile the `entities` table.
 *   3. Update membership cache to skip future hydration for cross-project keys.
 *
 * Run as a long-lived process:  bun run mirror
 *
 * Resumes from the last_processed_block stored in `daemon_state`. On clean start,
 * begins from the current block (no backfill). Run scripts/backfill.ts to ingest
 * historical Cortex entities into the mirror.
 */

import type { Database } from "./db";
import type { Hex } from "@arkiv-network/sdk";
import { parseAbi, decodeEventLog, toHex, keccak256, bytesToHex } from "viem";
import { getPublicClient } from "../lib/arkiv-client";
import { PROJECT_ATTRIBUTE, BRAGA } from "../constants";
import { appendToStateMMR } from "./state";
import { setPayloadHash } from "./db";
import {
  initMirrorDb,
  setDaemonState,
  getDaemonState,
  getMembership,
  setMembership,
  encodeAttributes,
  type EventType,
} from "./db";

// ---------------------------------------------------------------------------
// Hydrate concurrency control (shared by daemon + backfill).
//
// Bug we are fixing:
//   Previously hydrateEntity was called as `void hydrateEntity(...)` fire-and-
//   forget. When backfill processed a chunk of 1000 events, it spawned 1000
//   parallel getEntity (arkiv_query) calls. Braga RPC returned malformed JSON
//   or ECONNRESET under that load — hence the "Failed to parse JSON" storm.
//
// Fix: a tiny semaphore-with-queue that caps concurrent hydrations at
// HYDRATE_CONCURRENCY. Backfill awaits drainHydrateQueue() before exiting so
// we never lose work to process termination.
// ---------------------------------------------------------------------------

const HYDRATE_CONCURRENCY = 3;
const hydrateQueue: Array<() => Promise<void>> = [];
let hydrateActive = 0;

function scheduleHydrate(work: () => Promise<void>): void {
  hydrateQueue.push(work);
  pumpHydrateQueue();
}

function pumpHydrateQueue(): void {
  while (hydrateActive < HYDRATE_CONCURRENCY && hydrateQueue.length > 0) {
    const next = hydrateQueue.shift();
    if (!next) break;
    hydrateActive++;
    next()
      .catch((err) => {
        // Errors are already logged inside hydrateEntity — defensive catch only.
        console.warn("[mirror] hydrate worker error:", err instanceof Error ? err.message : err);
      })
      .finally(() => {
        hydrateActive--;
        pumpHydrateQueue();
      });
  }
}

/**
 * Wait until the hydrate queue is drained and no work is in flight.
 * Used by scripts/backfill.ts to avoid exiting mid-hydration.
 */
export async function drainHydrateQueue(): Promise<void> {
  while (hydrateQueue.length > 0 || hydrateActive > 0) {
    await Bun.sleep(100);
  }
}

// Arkiv events ABI — replicated from SDK so we can capture all six events
// (the SDK's official decorator omits onEntityOwnerChanged from its type).
// Exported so scripts/backfill.ts can reuse the same shape against
// publicClient.getLogs without redefining it.
export const ARKIV_EVENTS_ABI = parseAbi([
  "event ArkivEntityCreated(uint256 indexed entityKey, address indexed ownerAddress, uint256 expirationBlock, uint256 cost)",
  "event ArkivEntityUpdated(uint256 indexed entityKey, address indexed ownerAddress, uint256 oldExpirationBlock, uint256 newExpirationBlock, uint256 cost)",
  "event ArkivEntityExpired(uint256 indexed entityKey, address indexed ownerAddress)",
  "event ArkivEntityDeleted(uint256 indexed entityKey, address indexed ownerAddress)",
  "event ArkivEntityBTLExtended(uint256 indexed entityKey, address indexed ownerAddress, uint256 oldExpirationBlock, uint256 newExpirationBlock, uint256 cost)",
  "event ArkivEntityOwnerChanged(uint256 indexed entityKey, address indexed oldOwnerAddress, address indexed newOwnerAddress)",
]);

const RESUME_CURSOR_KEY = "last_processed_block";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DaemonOptions {
  /** Start polling from this block (overrides resume cursor). */
  fromBlock?: bigint;
  /** Polling interval in ms. SDK default is 1000ms. */
  pollingIntervalMs?: number;
  /** Verbose stdout logging. */
  verbose?: boolean;
}

export interface DaemonHandle {
  /** Stop the daemon. Resolves when the watcher is fully unsubscribed. */
  stop: () => void;
  /** Promise that resolves when the daemon exits (currently never, unless stop() called). */
  done: Promise<void>;
}

/**
 * Start the mirror daemon. Returns a handle for graceful shutdown.
 */
export async function startMirrorDaemon(options: DaemonOptions = {}): Promise<DaemonHandle> {
  const db = await initMirrorDb();
  const publicClient = getPublicClient();

  // Determine starting block
  let fromBlock = options.fromBlock;
  if (fromBlock === undefined) {
    const resumed = getDaemonState(db, RESUME_CURSOR_KEY);
    if (resumed) {
      fromBlock = BigInt(resumed);
      if (options.verbose) console.log(`[mirror] resuming from block ${fromBlock}`);
    } else {
      const timing = await publicClient.getBlockTiming();
      fromBlock = timing.currentBlock;
      if (options.verbose) {
        console.log(`[mirror] starting fresh from block ${fromBlock}`);
        console.log(
          `[mirror] note: only entities created from this block forward will be hydrated.`,
        );
        console.log(
          `[mirror] tip: run \`bun run backfill\` first to ingest existing Cortex entities.`,
        );
      }
    }
  }

  const log = options.verbose ? console.log : () => {};
  let stopped = false;

  // Counters surfaced via a 30s heartbeat so the operator can see the daemon
  // is actually doing something even when no Cortex events flow.
  let totalEventsSeen = 0;
  let lastBlock = Number(fromBlock);
  const startedAtMs = Date.now();
  const heartbeat = options.verbose
    ? setInterval(() => {
        const ageSec = Math.round((Date.now() - startedAtMs) / 1000);
        console.log(
          `[mirror] heartbeat @ ${ageSec}s — last block ${lastBlock}, ` +
            `${totalEventsSeen} events seen, ` +
            `hydrate q=${hydrateQueue.length} active=${hydrateActive}`,
        );
      }, 30_000)
    : null;

  // -------------------------------------------------------------------------
  // Manual polling loop (replaces viem watchEvent).
  //
  // Why not watchEvent: viem retries a failed eth_getLogs with the SAME block
  // range forever. If we resume from a cursor >MAX_RANGE blocks behind head,
  // every request hits "exceed max block range params" and the daemon spins
  // in an infinite error loop until killed.
  //
  // Fix: fixed-size chunked polling (CHUNK_SIZE blocks), exponential backoff
  // on errors, cursor advances only on successful responses. We also halve
  // the chunk size on "exceed max block range" so the daemon self-tunes if
  // Braga tightens its cap.
  // -------------------------------------------------------------------------

  const POLL_IDLE_MS = options.pollingIntervalMs ?? 2000;
  const MIN_CHUNK = 50n;
  let chunkSize = 500n; // Braga's published cap is undocumented; 500 is safe.
  let backoffMs = POLL_IDLE_MS;
  let cursor = fromBlock;

  void (async () => {
    while (!stopped) {
      try {
        const head = await publicClient.getBlockNumber();
        if (cursor > head) {
          await Bun.sleep(POLL_IDLE_MS);
          continue;
        }
        const span = head - cursor + 1n;
        const to = span < chunkSize ? head : cursor + chunkSize - 1n;

        const logs = await publicClient.getLogs({
          address: BRAGA.precompileAddress as Hex,
          events: ARKIV_EVENTS_ABI,
          fromBlock: cursor,
          toBlock: to,
        });

        if (options.verbose && logs.length > 0) {
          console.log(
            `[mirror] +${logs.length} event(s) blocks ${cursor}..${to}`,
          );
        }

        for (const rawLog of logs) {
          totalEventsSeen++;
          const blk = Number(rawLog.blockNumber ?? 0n);
          if (blk > lastBlock) lastBlock = blk;
          try {
            handleLog(db, publicClient, rawLog, log);
          } catch (err) {
            console.error(
              "[mirror] handleLog error:",
              err instanceof Error ? err.message : err,
            );
          }
        }

        // Success — advance cursor + reset backoff + grow chunk back up.
        cursor = to + 1n;
        backoffMs = POLL_IDLE_MS;
        if (chunkSize < 500n) chunkSize = chunkSize * 2n > 500n ? 500n : chunkSize * 2n;

        // If we just caught up, sleep before the next poll to avoid hot loop.
        if (logs.length === 0 || cursor > head) await Bun.sleep(POLL_IDLE_MS);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // RPC said the range is too big — shrink and retry the smaller window.
        if (/exceed max block range|max block range/i.test(msg) && chunkSize > MIN_CHUNK) {
          const next = chunkSize / 2n;
          chunkSize = next < MIN_CHUNK ? MIN_CHUNK : next;
          console.warn(
            `[mirror] RPC max-range hit; halving chunk to ${chunkSize}, no backoff.`,
          );
          continue; // retry immediately with smaller range
        }
        // Generic transport/parse error — exponential backoff, DON'T retry the
        // identical range. Cursor stays put; we'll re-fetch the same window
        // after the backoff window elapses.
        console.warn(
          `[mirror] poll error @ cursor ${cursor} (backoff ${backoffMs}ms): ${msg.slice(0, 200)}`,
        );
        await Bun.sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 60_000);
      }
    }
  })();

  let resolveDone: () => void;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (heartbeat) clearInterval(heartbeat);
      resolveDone();
      log("[mirror] stopped");
    },
    done,
  };
}

// ---------------------------------------------------------------------------
// Event handling
// ---------------------------------------------------------------------------

export interface RawLog {
  blockNumber: bigint | null;
  transactionHash: Hex | null;
  logIndex: number | null;
  topics: readonly Hex[];
  data: Hex;
}

/**
 * Decode and apply one raw Arkiv event log. Exported so historical-replay
 * tooling (scripts/backfill.ts) can reuse the exact same insert path the
 * live daemon uses — there is only one source of truth for how an event
 * becomes a mirror row.
 */
export function handleLog(
  db: Database,
  publicClient: ReturnType<typeof getPublicClient>,
  rawLog: RawLog,
  log: (...args: unknown[]) => void,
): void {
  const decoded = decodeEventLog({
    abi: ARKIV_EVENTS_ABI,
    topics: rawLog.topics as [Hex, ...Hex[]] | [],
    data: rawLog.data,
  });

  const blockNumber = Number(rawLog.blockNumber ?? 0n);
  const observed = Date.now();
  let eventType: EventType;
  let entityKey: Hex;
  let owner: Hex | null = null;
  let oldOwner: Hex | null = null;
  let newOwner: Hex | null = null;
  let oldExpiry: number | null = null;
  let newExpiry: number | null = null;
  let cost: string | null = null;

  switch (decoded.eventName) {
    case "ArkivEntityCreated":
      eventType = "created";
      entityKey = toHex(decoded.args.entityKey, { size: 32 });
      owner = decoded.args.ownerAddress;
      newExpiry = Number(decoded.args.expirationBlock);
      cost = decoded.args.cost.toString();
      break;
    case "ArkivEntityUpdated":
      eventType = "updated";
      entityKey = toHex(decoded.args.entityKey, { size: 32 });
      owner = decoded.args.ownerAddress;
      oldExpiry = Number(decoded.args.oldExpirationBlock);
      newExpiry = Number(decoded.args.newExpirationBlock);
      cost = decoded.args.cost.toString();
      break;
    case "ArkivEntityBTLExtended":
      eventType = "extended";
      entityKey = toHex(decoded.args.entityKey, { size: 32 });
      owner = decoded.args.ownerAddress;
      oldExpiry = Number(decoded.args.oldExpirationBlock);
      newExpiry = Number(decoded.args.newExpirationBlock);
      cost = decoded.args.cost.toString();
      break;
    case "ArkivEntityDeleted":
      eventType = "deleted";
      entityKey = toHex(decoded.args.entityKey, { size: 32 });
      owner = decoded.args.ownerAddress;
      break;
    case "ArkivEntityExpired":
      eventType = "expired";
      entityKey = toHex(decoded.args.entityKey, { size: 32 });
      owner = decoded.args.ownerAddress;
      break;
    case "ArkivEntityOwnerChanged":
      eventType = "owner_changed";
      entityKey = toHex(decoded.args.entityKey, { size: 32 });
      oldOwner = decoded.args.oldOwnerAddress;
      newOwner = decoded.args.newOwnerAddress;
      break;
    default:
      log("[mirror] unhandled event:", (decoded as { eventName?: string }).eventName);
      return;
  }

  // 1. Always append to the event log (project filter is applied to entities table only)
  db.prepare(
    "INSERT INTO events (block_number, tx_hash, log_index, event_type, entity_key, owner, " +
      "old_owner, new_owner, old_expiration_block, new_expiration_block, cost, observed_at_ms) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    blockNumber,
    rawLog.transactionHash,
    rawLog.logIndex,
    eventType,
    entityKey,
    owner,
    oldOwner,
    newOwner,
    oldExpiry,
    newExpiry,
    cost,
    observed,
  );

  // 2. Decide whether this entity is ours (Cortex namespace)
  let membership = getMembership(db, entityKey);

  if (membership === null) {
    // Only spend an RPC call on `created` events. For other event types, if we
    // don't know the entity, it's not ours (we'd have seen its create).
    if (eventType !== "created") {
      // Treat as out-of-project for now; don't pollute membership table.
      setDaemonState(db, RESUME_CURSOR_KEY, String(blockNumber));
      return;
    }
    membership = false; // pessimistic — will be set true by hydrate if ours
    scheduleHydrate(() =>
      hydrateEntity(db, publicClient, entityKey, blockNumber, eventType, owner, newExpiry, log),
    );
    setDaemonState(db, RESUME_CURSOR_KEY, String(blockNumber));
    return;
  }

  if (!membership) {
    // Confirmed not-ours; skip.
    setDaemonState(db, RESUME_CURSOR_KEY, String(blockNumber));
    return;
  }

  // 3. Membership confirmed — apply event to entities table
  applyEventToEntity(db, entityKey, eventType, owner, newExpiry, blockNumber, oldOwner, newOwner, log);

  setDaemonState(db, RESUME_CURSOR_KEY, String(blockNumber));
}

async function hydrateEntity(
  db: Database,
  publicClient: ReturnType<typeof getPublicClient>,
  entityKey: Hex,
  blockNumber: number,
  eventType: EventType,
  owner: Hex | null,
  newExpiry: number | null,
  log: (...args: unknown[]) => void,
): Promise<void> {
  try {
    const entity = await publicClient.getEntity(entityKey);
    const hasProjectAttr = entity.attributes.some(
      (a) => a.key === PROJECT_ATTRIBUTE.key && a.value === PROJECT_ATTRIBUTE.value,
    );
    setMembership(db, entityKey, hasProjectAttr);

    if (!hasProjectAttr) {
      return;
    }

    db.prepare(
      "INSERT INTO entities (entity_key, owner, creator, content_type, payload, attributes_json, " +
        "expires_at_block, created_at_block, last_modified_at_block, state, first_seen_block, " +
        "last_event_block, last_event_type, hydrated_at_ms) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', ?, ?, ?, ?) " +
        "ON CONFLICT(entity_key) DO UPDATE SET " +
        "  owner = excluded.owner, " +
        "  creator = COALESCE(entities.creator, excluded.creator), " +
        "  content_type = excluded.content_type, " +
        "  payload = excluded.payload, " +
        "  attributes_json = excluded.attributes_json, " +
        "  expires_at_block = excluded.expires_at_block, " +
        "  last_modified_at_block = excluded.last_modified_at_block, " +
        "  last_event_block = excluded.last_event_block, " +
        "  last_event_type = excluded.last_event_type, " +
        "  hydrated_at_ms = excluded.hydrated_at_ms",
    ).run(
      entityKey,
      entity.owner ?? owner,
      entity.creator ?? null,
      entity.contentType ?? null,
      entity.payload ?? null,
      encodeAttributes(entity.attributes),
      Number(entity.expiresAtBlock ?? newExpiry ?? 0),
      entity.createdAtBlock ? Number(entity.createdAtBlock) : null,
      entity.lastModifiedAtBlock ? Number(entity.lastModifiedAtBlock) : blockNumber,
      blockNumber,
      blockNumber,
      eventType,
      Date.now(),
    );
    log(`[mirror] hydrated Cortex entity ${entityKey} @ block ${blockNumber}`);

    // Phase 12 — Merkleized Memory ingestion hook.
    // Compute keccak256(payload), persist alongside the entity, and append to
    // the in-memory MMR. We do this AFTER the INSERT so a crash mid-hydrate
    // doesn't leave a hash without its payload. The MMR is rebuilt on boot
    // from listLeafHashesInOrder, so a missed append here recovers on restart.
    //
    // Phase 13 — exclude STATE_ROOT entities from the MMR. They are themselves
    // commitments TO the MMR; including them would cause infinite recursion
    // (every anchor would change the root, requiring another anchor, etc.).
    //
    // Skip if payload is empty/missing — there's nothing to commit.
    const entityTypeAttr = entity.attributes.find(
      (a) => a.key === "entityType",
    )?.value;
    const isStateRoot = entityTypeAttr === "state_root";
    if (
      entity.payload &&
      entity.payload.byteLength > 0 &&
      !isStateRoot
    ) {
      try {
        const hashHex = bytesToHex(keccak256(entity.payload, "bytes"));
        setPayloadHash(db, entityKey, hashHex);
        // appendToStateMMR is async (it lazily builds the singleton); fire and
        // forget — errors are logged but don't fail the hydrate.
        void appendToStateMMR(hashHex).catch((err) => {
          console.warn(
            `[mirror] MMR append failed for ${entityKey}:`,
            err instanceof Error ? err.message : err,
          );
        });
      } catch (err) {
        console.warn(
          `[mirror] payload_hash computation failed for ${entityKey}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  } catch (err) {
    // NoEntityFoundError is EXPECTED, not an error. It means the chain has
    // already evicted this entity (expired) between when we observed its
    // Created event and when we got around to hydrating. Working-tier
    // memories live 1 hour, but backfill can scan 2.8 hours back — so many
    // hydrate attempts on backfilled events legitimately find nothing.
    //
    // Mark membership=false so we don't try again, and log at info level.
    // See docs/MIRROR.md §2 for the full Arkiv-eviction story.
    const errName = (err as { name?: string })?.name;
    if (errName === "NoEntityFoundError") {
      try {
        setMembership(db, entityKey, false);
      } catch {
        /* membership write may itself contend on the DB; safe to drop */
      }
      log(
        `[mirror] entity ${entityKey.slice(0, 10)}… already evicted on Arkiv (expected, not an error)`,
      );
      return;
    }
    // Anything else IS a real problem — surface it.
    console.error(
      `[mirror] hydrate failed for ${entityKey}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

function applyEventToEntity(
  db: Database,
  entityKey: Hex,
  eventType: EventType,
  owner: Hex | null,
  newExpiry: number | null,
  blockNumber: number,
  oldOwner: Hex | null,
  newOwner: Hex | null,
  log: (...args: unknown[]) => void,
): void {
  switch (eventType) {
    case "extended":
    case "updated":
      if (newExpiry !== null) {
        db.prepare(
          "UPDATE entities SET expires_at_block = ?, last_event_block = ?, last_event_type = ?, last_modified_at_block = ? WHERE entity_key = ?",
        ).run(newExpiry, blockNumber, eventType, blockNumber, entityKey);
      }
      break;
    case "deleted":
      db.prepare(
        "UPDATE entities SET state = 'deleted', last_event_block = ?, last_event_type = ? WHERE entity_key = ?",
      ).run(blockNumber, eventType, entityKey);
      break;
    case "expired":
      db.prepare(
        "UPDATE entities SET state = 'expired', last_event_block = ?, last_event_type = ? WHERE entity_key = ?",
      ).run(blockNumber, eventType, entityKey);
      break;
    case "owner_changed":
      if (newOwner) {
        db.prepare(
          "UPDATE entities SET owner = ?, last_event_block = ?, last_event_type = ? WHERE entity_key = ?",
        ).run(newOwner, blockNumber, eventType, entityKey);
        log(`[mirror] owner_changed ${entityKey}: ${oldOwner} → ${newOwner}`);
      }
      break;
    case "created":
      // Already handled by hydrate on first-seen path
      break;
  }
}

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const verbose = !process.env.CORTEX_MIRROR_QUIET;
  console.log("[mirror] starting Cortex mirror daemon");
  console.log("[mirror] SQLite path:", process.env.CORTEX_MIRROR_PATH ?? "./cortex-mirror.sqlite");

  const handle = await startMirrorDaemon({ verbose });

  const shutdown = () => {
    console.log("\n[mirror] shutdown signal received");
    handle.stop();
    setTimeout(() => process.exit(0), 250);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await handle.done;
}
