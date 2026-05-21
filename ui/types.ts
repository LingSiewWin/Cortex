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
