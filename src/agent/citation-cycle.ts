/**
 * Cortex — shared citation cycle (Phase 16).
 *
 * The recall → emit recall.completed → act core, shared by:
 *   - the autonomous loop (src/agent/autonomous-loop.ts), which wraps it with
 *     the allowance gate + agent.loop.tick + allowance.spent + scheduling
 *   - the manual "Cite" endpoint (src/api/citation.ts)
 *
 * Keeping this in one place guarantees the dashboard animates identically
 * whether the cite was triggered autonomously or by a judge typing a query.
 */

import type { Hex } from "@arkiv-network/sdk";
import { recall as realRecall, type MemoryHit } from "../darwinian/recall.ts";
import { act as realAct, type ActResult, type ActOptions } from "../darwinian/citation.ts";
import { publish } from "../lib/events.ts";

export interface CiteCycleDeps {
  recall?: (opts: { query: string; k?: number }) => Promise<MemoryHit[]>;
  act?: (opts: ActOptions) => Promise<ActResult>;
}

export interface CiteCycleOptions {
  query: string;
  userPrimaryEOA: Hex;
  k?: number;
  /** How many of the recall hits to cite. Default 1. */
  citeTopN?: number;
  /** Label prefix for the act action. Default "cite". */
  actionLabel?: string;
  sessionId?: string;
  deps?: CiteCycleDeps;
}

export interface CiteCycleResult {
  query: string;
  hits: MemoryHit[];
  /** Entity keys actually cited (≤ citeTopN). */
  selected: Hex[];
  /** act() result, or null when recall returned nothing to cite. */
  act: ActResult | null;
}

/**
 * Run one recall → recall.completed → act cycle. Emits `recall.completed`
 * (always) and, when there's something to cite, drives act() — which itself
 * emits memory.cited / mmr.appended / anchor.committed / arkiv.rpc.call.
 *
 * Does NOT emit agent.loop.tick or allowance.spent — those are loop concerns.
 */
export async function runCiteCycle(
  opts: CiteCycleOptions,
): Promise<CiteCycleResult> {
  const recall = opts.deps?.recall ?? ((o) => realRecall(o));
  const act = opts.deps?.act ?? ((o) => realAct(o));
  const k = opts.k ?? 5;
  const citeTopN = opts.citeTopN ?? 1;
  const label = opts.actionLabel ?? "cite";

  const hits = await recall({ query: opts.query, k });
  const selected = hits.slice(0, citeTopN).map((h) => h.entityKey);

  publish({
    type: "recall.completed",
    ts: Date.now(),
    query: opts.query,
    candidateIds: hits.map((h) => h.entityKey),
    selectedId: selected[0] ?? null,
  });

  if (selected.length === 0) {
    return { query: opts.query, hits, selected, act: null };
  }

  const result = await act({
    action: `${label}: ${opts.query}`,
    citations: selected,
    userPrimaryEOA: opts.userPrimaryEOA,
    sessionId: opts.sessionId ?? "cite-cycle",
  });

  return { query: opts.query, hits, selected, act: result };
}
