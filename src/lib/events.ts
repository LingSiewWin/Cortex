/**
 * Cortex — Live Spine domain event bus (Phase 16).
 *
 * Single in-process publish/subscribe bus that all spine sources feed:
 *   - arkiv-client.ts wrapper (every RPC call → arkiv.rpc.call)
 *   - embeddings.ts (every RaBitQ encode → rabitq.encoded)
 *   - mmr.ts (every append → mmr.appended)
 *   - citation.ts act() (memory.created, memory.cited, anchor.committed)
 *   - autonomous-loop.ts (agent.loop.tick, recall.completed)
 *   - api/allowance.ts (allowance.spent)
 *
 * The SSE endpoint (src/api/sse.ts) bridges this bus to browser clients.
 *
 * Architecture (research-grounded, see docs/specs/2026-05-22-cortex-live-spine-plan.md):
 *   - EventTarget for fan-out (built-in, zero deps)
 *   - Map<type, ringBuffer<200>> for Last-Event-ID replay on SSE reconnect
 *   - Monotonic seq id so clients can resume from any point
 *
 * Test seam: `_resetBus()` clears state for hermetic tests.
 */

import type { Hex } from "@arkiv-network/sdk";

// ---------------------------------------------------------------------------
// Event shapes (spec §8)
//
// All events share a `type` discriminator and `ts` (millis since epoch).
// Add fields freely as the spine grows — but never break a published type
// (subscribers depend on it). Add a `v2` variant instead.
// ---------------------------------------------------------------------------

export type ArkivRpcMethod =
  | "getEntity"
  | "mutateEntities"
  | "extendEntity"
  | "queryEntities";

export type TierName = "working" | "episodic" | "rule";

export type DomainEvent =
  | {
      type: "arkiv.rpc.call";
      ts: number;
      method: ArkivRpcMethod;
      byteSize: number;
      ms: number;
      txHash?: string;
      blockNumber?: number;
      ok: boolean;
      errorMessage?: string;
    }
  | {
      type: "rabitq.encoded";
      ts: number;
      dim: number;
      bytes: number;
      ratio: number;
      ms: number;
    }
  | {
      type: "memory.created";
      ts: number;
      entityKey: Hex;
      tier: TierName;
      expiresAtBlock: number;
    }
  | {
      type: "memory.cited";
      ts: number;
      entityKey: Hex;
      /** Lease growth applied this citation (the accumulative-extend delta). */
      reinforcementSeconds: number;
      promotedTo?: "episodic" | "rule";
    }
  | {
      type: "mmr.appended";
      ts: number;
      leafIndex: number;
      leafHash: Hex;
      newRoot: Hex;
      leafCount: number;
    }
  | {
      type: "anchor.committed";
      ts: number;
      rootHex: Hex;
      leafCount: number;
      txHash: string;
      blockNumber?: number;
    }
  | {
      type: "allowance.spent";
      ts: number;
      wei: string;
      remainingWei: string;
      runwaySeconds: number;
    }
  | {
      type: "agent.loop.tick";
      ts: number;
      query: string;
      queuedAt: number;
    }
  | {
      type: "recall.completed";
      ts: number;
      query: string;
      candidateIds: Hex[];
      selectedId: Hex | null;
    };

export type DomainEventType = DomainEvent["type"];

/**
 * Canonical list of every event type. Single source of truth for the SSE
 * endpoint's `?types=` allow-list and for tests. Keep in sync with the
 * DomainEvent union above (TS will not enforce exhaustiveness here, so the
 * `assertAllTypesListed` test in tests/events.test.ts guards it).
 */
export const ALL_EVENT_TYPES: DomainEventType[] = [
  "arkiv.rpc.call",
  "rabitq.encoded",
  "memory.created",
  "memory.cited",
  "mmr.appended",
  "anchor.committed",
  "allowance.spent",
  "agent.loop.tick",
  "recall.completed",
];

/** Envelope assigned by the bus — adds a monotonic id for Last-Event-ID resume. */
export interface BufferedEvent {
  id: string;
  type: DomainEventType;
  event: DomainEvent;
}

// ---------------------------------------------------------------------------
// Module state — kept private to this file
// ---------------------------------------------------------------------------

const RING_CAP_PER_TYPE = 200;

const buffers = new Map<DomainEventType, BufferedEvent[]>();
const dispatcher = new EventTarget();
/** Tracked wrapped listeners so _resetBus can hard-clear them in tests. */
const wrappedListeners = new Set<(e: Event) => void>();
let seq = 0;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Publish an event to all subscribers and persist into the per-type ring.
 * Returns the buffered envelope so callers can inspect the assigned id.
 *
 * Errors thrown by individual subscribers are caught and logged — one
 * misbehaving subscriber should not break the rest of the fan-out.
 */
export function publish(event: DomainEvent): BufferedEvent {
  seq += 1;
  const envelope: BufferedEvent = {
    id: String(seq),
    type: event.type,
    event,
  };
  const ring = buffers.get(event.type) ?? [];
  ring.push(envelope);
  if (ring.length > RING_CAP_PER_TYPE) ring.shift();
  buffers.set(event.type, ring);

  dispatcher.dispatchEvent(
    new CustomEvent("evt", { detail: envelope }),
  );
  return envelope;
}

/**
 * Subscribe to ALL events on the bus. Returns an unsubscribe function.
 * The caller must filter by `envelope.type` if it only cares about some types.
 *
 * Filtering at the subscribe layer keeps this primitive small. The SSE
 * endpoint filters per-connection based on `?types=` query param.
 */
export function subscribe(
  handler: (envelope: BufferedEvent) => void,
): () => void {
  const wrapped = (e: Event) => {
    const envelope = (e as CustomEvent<BufferedEvent>).detail;
    try {
      handler(envelope);
    } catch (err) {
      // Log but never re-throw — one bad subscriber must not poison the bus.
      // eslint-disable-next-line no-console
      console.error(
        `[cortex/events] subscriber threw on ${envelope.type}:`,
        err,
      );
    }
  };
  dispatcher.addEventListener("evt", wrapped);
  wrappedListeners.add(wrapped);
  return () => {
    dispatcher.removeEventListener("evt", wrapped);
    wrappedListeners.delete(wrapped);
  };
}

/**
 * Replay buffered events for the requested types, in chronological order
 * (ascending `id`). `sinceId` filters out anything with id <= sinceId.
 * `perType` caps how many of each type are returned (default 10) — useful
 * for SSE reconnect where we want a fresh snapshot, not a full history.
 *
 * Pass an empty `types` array to replay nothing (returns []).
 */
export function replay(
  types: readonly DomainEventType[],
  sinceId?: string | null,
  perType = 10,
): BufferedEvent[] {
  if (types.length === 0) return [];
  const since = sinceId ? Number(sinceId) : 0;
  // Guard against NaN / negative sinceId (malformed Last-Event-ID).
  const sinceSafe = Number.isFinite(since) && since > 0 ? since : 0;
  const out: BufferedEvent[] = [];
  for (const t of types) {
    const ring = buffers.get(t);
    if (!ring) continue;
    // Slice the tail respecting both filters. perType is small so this is cheap.
    const filtered = ring.filter((e) => Number(e.id) > sinceSafe);
    out.push(...filtered.slice(-perType));
  }
  // Stable chronological order across types.
  out.sort((a, b) => Number(a.id) - Number(b.id));
  return out;
}

/** Snapshot the set of event types currently in the buffer. Debug + tests. */
export function bufferedTypes(): DomainEventType[] {
  return Array.from(buffers.keys());
}

/** Snapshot the current seq counter. Tests use this to assert monotonicity. */
export function currentSeq(): number {
  return seq;
}

// ---------------------------------------------------------------------------
// Test seam
// ---------------------------------------------------------------------------

/**
 * Reset the bus to initial state. Tests MUST call this in `beforeEach` to
 * avoid cross-test contamination (the bus is a module-level singleton).
 *
 * Production code must never call this.
 */
export function _resetBus(): void {
  buffers.clear();
  seq = 0;
  for (const wrapped of wrappedListeners) {
    dispatcher.removeEventListener("evt", wrapped);
  }
  wrappedListeners.clear();
}
