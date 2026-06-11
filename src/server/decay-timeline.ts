/**
 * Cortex — Decay Receipt timeline endpoint (`/api/decay/timeline?entityKey=…`).
 *
 * Renders one memory's life as a lease-over-time step curve: the on-chain spine
 * (created → each anchored extend → eviction) plus the committed-but-not-yet-
 * anchored cites overlaid as a "queued" step, plus a synthetic dashed downslope
 * showing the projected eviction if the memory is never cited again. This is the
 * Decay Receipt's visual half — the artifact no generic memory layer (mem0/Letta/
 * vector-DB/IPFS/S3) can draw, because only Arkiv prices lease + evicts for free.
 *
 * Honesty rules baked in (per the demo-readiness audit):
 *   - Each on-chain point's `leaseSeconds` is derived from the event's OWN block +
 *     expiry ((new_expiration_block − block_number) × blockTime) — NOT from a
 *     global chain head, so it's correct even though the plugin-first product runs
 *     no sync daemon (no reliable `last_processed_block`).
 *   - Optimistic act() means a freshly-cited memory has NO `extended` rows yet, so
 *     the climb is shown from committed-local state and labelled `source:"projected"`
 *     ("queued / not yet anchored"). The downslope is `source:"synthetic"`.
 *   - `estimated` is true whenever any projected/synthetic point is present.
 */

import type { Hex } from "@arkiv-network/sdk";
import { getEventsForEntity } from "../mirror/replay.ts";
import { initMirrorDb, listPendingOutbox, type EventRow } from "../mirror/db.ts";
import { BRAGA } from "../constants.ts";

export type DecayPointSource = "onchain" | "projected" | "synthetic";

export interface DecayPoint {
  /** Wall-clock ms of this point (what the audience feels). */
  tMs: number;
  /** Lease remaining at this point, in seconds (the y-axis). */
  leaseSeconds: number;
  source: DecayPointSource;
  /** created | extended | queued | evicted | neglect */
  eventType: string;
  txHash: Hex | null;
  label: string;
}

export interface DecayTimelineResponse {
  entityKey: string;
  cortexId: string;
  points: DecayPoint[];
  /** live = on-chain; queued = committed-local, not yet anchored; expired/unknown. */
  state: "live" | "queued" | "expired" | "unknown";
  /** true when any point is projected/synthetic rather than chain-confirmed. */
  estimated: boolean;
  note: string;
}

/** Compact lease duration for labels. */
function fmtLease(s: number): string {
  if (s <= 0) return "0";
  if (s >= 86_400) return `~${(s / 86_400).toFixed(1)}d`;
  if (s >= 3_600) return `~${Math.round(s / 3_600)}h`;
  return `~${Math.max(1, Math.round(s / 60))}m`;
}

type TimelineEvent = Pick<
  EventRow,
  "event_type" | "block_number" | "old_expiration_block" | "new_expiration_block" | "tx_hash" | "observed_at_ms"
>;

/**
 * Pure timeline builder — no I/O, exhaustively testable. Takes the entity's event
 * log (block-ascending), the sum of committed-but-unanchored extend seconds for
 * this key, and `nowMs` for the projected/synthetic points.
 */
export function buildDecayTimeline(input: {
  entityKey: string;
  events: TimelineEvent[];
  pendingSeconds: number;
  blockTimeSeconds: number;
  nowMs: number;
}): DecayTimelineResponse {
  const { entityKey, events, pendingSeconds, blockTimeSeconds, nowMs } = input;
  const cortexId = `cortex://${entityKey}`;
  const points: DecayPoint[] = [];
  let state: "live" | "queued" | "expired" | "unknown" = events.length > 0 ? "live" : "unknown";

  const leaseAt = (ev: TimelineEvent): number =>
    ev.new_expiration_block !== null
      ? Math.max(0, ev.new_expiration_block - ev.block_number) * blockTimeSeconds
      : 0;

  for (const ev of events) {
    if (ev.event_type === "created") {
      const lease = leaseAt(ev);
      points.push({
        tMs: ev.observed_at_ms,
        leaseSeconds: lease,
        source: "onchain",
        eventType: "created",
        txHash: ev.tx_hash,
        label: `created · ${fmtLease(lease)} lease`,
      });
    } else if (ev.event_type === "extended" || ev.event_type === "updated") {
      const lease = leaseAt(ev);
      const gained =
        ev.new_expiration_block !== null && ev.old_expiration_block !== null
          ? Math.max(0, ev.new_expiration_block - ev.old_expiration_block) * blockTimeSeconds
          : 0;
      points.push({
        tMs: ev.observed_at_ms,
        leaseSeconds: lease,
        source: "onchain",
        eventType: "extended",
        txHash: ev.tx_hash,
        label: `cited · +${fmtLease(gained)} → ${fmtLease(lease)}`,
      });
    } else if (ev.event_type === "expired" || ev.event_type === "deleted") {
      points.push({
        tMs: ev.observed_at_ms,
        leaseSeconds: 0,
        source: "onchain",
        eventType: "evicted",
        txHash: ev.tx_hash,
        label: ev.event_type === "expired" ? "evicted (lease lapsed)" : "deleted",
      });
      state = "expired";
    }
  }

  const last = points.length > 0 ? points[points.length - 1]! : null;

  // Committed-but-unanchored cites: optimistic act() enqueues extends that only
  // become on-chain `extended` rows after the worker anchors them. Surface them as
  // ONE projected step so the climb is real (committed local SEDM state) without
  // faking per-cite chain history we don't have.
  if (pendingSeconds > 0 && state !== "expired") {
    const base = last ? last.leaseSeconds : 0;
    points.push({
      tMs: nowMs,
      leaseSeconds: base + pendingSeconds,
      source: "projected",
      eventType: "queued",
      txHash: null,
      label: `+${fmtLease(pendingSeconds)} queued (not yet anchored)`,
    });
  }

  // Synthetic downslope: the "neglect → eviction" half of the story. A still-live
  // memory has no eviction event yet, so we DRAW the projected decay to zero.
  if (state !== "expired" && points.length > 0) {
    const tail = points[points.length - 1]!;
    points.push({
      tMs: tail.tMs + tail.leaseSeconds * 1_000,
      leaseSeconds: 0,
      source: "synthetic",
      eventType: "neglect",
      txHash: null,
      label: "projected eviction if never cited again",
    });
  }

  // A memory cited before its create has anchored has local points but no chain
  // events — surface that as "queued", not "unknown" (the header sat above a
  // populated curve while claiming no data existed — verify-debate MUST-FIX #2).
  if (state === "unknown" && pendingSeconds > 0) state = "queued";

  const estimated = points.some((p) => p.source !== "onchain");
  const note =
    events.length === 0
      ? pendingSeconds > 0
        ? "Committed locally (optimistic) — not yet anchored on Braga; the climb is real, the chain catches up via the worker."
        : "No events for this memory yet (not cited, or not this project)."
      : estimated
        ? "Solid = anchored on Braga; dashed = committed-local / projected decay."
        : "Fully reconstructed from on-chain events.";

  return { entityKey, cortexId, points, state, estimated, note };
}

/** Sum the committed-but-unanchored extend seconds for one entity key. */
function pendingSecondsFor(db: Awaited<ReturnType<typeof initMirrorDb>>, key: string): number {
  let total = 0;
  for (const ob of listPendingOutbox(db, 500)) {
    for (const it of ob.bundle.reinforceItems) {
      if (it.entityKey.toLowerCase() === key.toLowerCase()) total += it.reinforcementSeconds;
    }
  }
  return total;
}

export async function handleDecayTimelineRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const entityKey = url.searchParams.get("entityKey");
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

  if (!entityKey || !/^0x[0-9a-fA-F]{64}$/.test(entityKey)) {
    return new Response(
      JSON.stringify({ error: "entityKey query param required (0x + 64 hex)" }),
      { status: 400, headers },
    );
  }

  try {
    const db = await initMirrorDb();
    const events = await getEventsForEntity(entityKey as Hex);
    const pendingSeconds = pendingSecondsFor(db, entityKey);
    const timeline = buildDecayTimeline({
      entityKey,
      events,
      pendingSeconds,
      blockTimeSeconds: BRAGA.blockTimeSeconds,
      nowMs: Date.now(),
    });
    return new Response(JSON.stringify(timeline), { status: 200, headers });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers },
    );
  }
}
