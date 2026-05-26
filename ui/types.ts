/**
 * Cortex — Ambient Dashboard wire types.
 *
 * Mirrors the shapes returned by `src/ui-server.ts`. Kept in `ui/` so the
 * frontend bundle doesn't drag in `bun:sqlite` (which is what re-exporting
 * the server types directly would do).
 */

export type Hex = `0x${string}`;
export type MemoryTier = "working" | "episodic" | "rule" | "other";

export interface MemorySummary {
  entityKey: Hex;
  owner: Hex;
  creator: Hex | null;
  tier: MemoryTier;
  entityType: string | null;
  expiresAtBlock: number;
  createdAtBlock: number | null;
  remainingRatio: number;
  remainingSeconds: number;
  lifespanSeconds: number;
  state: "live" | "deleted" | "expired";
  lastEventBlock: number;
  lastEventType: string;
  /** Total citations across all sessions (0 if uncited). */
  citationCount: number;
  /** Distinct sessions that cited it. */
  distinctSessions: number;
  /** Tier it was promoted to (episode/rule), or null. */
  promotedTo: "episode" | "rule" | null;
  /** Evolved SEDM utility weight (1.0 = neutral baseline). */
  weight: number;
}

export interface MemoriesResponse {
  currentBlock: number;
  counts: {
    total: number;
    working: number;
    episodic: number;
    rule: number;
    other: number;
  };
  memories: MemorySummary[];
}

export interface DecisionRecord {
  entityKey: Hex;
  blockNumber: number;
  action: string;
  citedKeys: Hex[];
}

export interface DecisionsResponse {
  decisions: DecisionRecord[];
}

export interface ListingSummary {
  entityKey: Hex;
  owner: Hex;
  tags: { key: string; value: string | number }[];
  priceWei: string;
  sales: number;
  totalEarnedWei: string;
  lastSaleAtBlock: number | null;
}

export interface ListingsResponse {
  listings: ListingSummary[];
  aggregate: {
    totalEarnedWei: string;
    lastSaleAtBlock: number | null;
    activeListings: number;
  };
}

export interface MemoryDetailResponse {
  summary: MemorySummary;
  attributes: { key: string; value: string | number }[];
  payloadPreview: string | null;
}

export interface WalletCapsView {
  atomicBatch: boolean;
  paymasterService: boolean;
  sessionKeys: boolean;
}

// ---------------------------------------------------------------------------
// Live Spine event types (Phase 16).
//
// Wire-compatible mirror of `src/lib/events.ts` DomainEvent. Kept here (not
// imported from src/) so the frontend bundle never pulls the server-side
// event bus / EventTarget singleton. Same convention as the wire types above.
// ---------------------------------------------------------------------------

export type ArkivRpcMethod =
  | "getEntity"
  | "mutateEntities"
  | "extendEntity"
  | "queryEntities";

export type SpineTier = "working" | "episodic" | "rule";

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
  | { type: "rabitq.encoded"; ts: number; dim: number; bytes: number; ratio: number; ms: number }
  | { type: "memory.created"; ts: number; entityKey: Hex; tier: SpineTier; expiresAtBlock: number }
  | {
      type: "memory.cited";
      ts: number;
      entityKey: Hex;
      reinforcementSeconds: number;
      promotedTo?: "episodic" | "rule";
    }
  | { type: "mmr.appended"; ts: number; leafIndex: number; leafHash: Hex; newRoot: Hex; leafCount: number }
  | { type: "anchor.committed"; ts: number; rootHex: Hex; leafCount: number; txHash: string; blockNumber?: number }
  | { type: "allowance.spent"; ts: number; wei: string; remainingWei: string; runwaySeconds: number }
  | { type: "agent.loop.tick"; ts: number; query: string; queuedAt: number }
  | { type: "recall.completed"; ts: number; query: string; candidateIds: Hex[]; selectedId: Hex | null };

export type DomainEventType = DomainEvent["type"];

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

/** Envelope as delivered over SSE — `id` is the server's monotonic seq. */
export interface SpineEvent {
  id: string;
  type: DomainEventType;
  event: DomainEvent;
}

/** Narrow a SpineEvent to a specific event type (type guard for consumers). */
export type EventOf<T extends DomainEventType> = Extract<DomainEvent, { type: T }>;
