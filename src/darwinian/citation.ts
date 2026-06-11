/**
 * Cortex — act() / citation tracker.
 *
 * The agent has exactly two memory tools (CLAUDE.md "Citation-driven reinforcement"):
 *   - recall(query, k)
 *   - act(action, citations)
 *
 * Optimistic Memory Buffering — act() never blocks on Braga's block time.
 * Every act() call runs entirely against the local SQLite mirror + in-process
 * state, then defers all on-chain work to a durable outbox the anchor worker
 * drains (src/agent/anchor-worker.ts):
 *   1. Validates citations against the last recall set (hallucinations dropped).
 *   2. Increments per-memory citation counts in bun:sqlite.
 *   3. Computes the accumulative reinforcement amount per citation (SEDM-scaled)
 *      and evolves each memory's utility weight — locally, no chain call.
 *   4. Marks any memory that crossed the working→episodic threshold promoted
 *      (the on-chain ownership transfer to the user EOA happens when the worker
 *      drains the bundle — see lib/ownership.ts).
 *   5. Flags any memory ready for semantic distillation (distill.ts cron).
 *   6. Builds the on-chain CITATION payload (carrying the POST-act scores) +
 *      enqueues an `act_bundle` to the outbox, then returns immediately. The
 *      worker fires extend → promote → write-citation → MMR-append → anchor,
 *      and reconciles the cited rows verified=true once the anchor lands.
 *
 * The agent's next recall() (already reads the local mirror) sees the evolved
 * state instantly — the chain catches up asynchronously. Citation tracking lives
 * in the SQLite mirror (citation_counts + citation_sessions); the sqlite counters
 * are the source of truth for tier promotions, the Arkiv lifespan for "alive?".
 */

import type { Database } from "../mirror/db";
import type { Hex } from "@arkiv-network/sdk";
import { jsonToPayload } from "@arkiv-network/sdk/utils";
import { keccak256, bytesToHex } from "viem";
import {
  initMirrorDb,
  getMemoryWeight,
  setMemoryWeight,
  getCitationRows,
  enqueueOutbox,
  getDaemonState,
  listPendingOutbox,
  type OutboxBundle,
} from "../mirror/db.ts";
import { getLastRecallIds, getLastRecallRanks, getLastRecallK } from "./recall.ts";
import { REINFORCEMENT, ENTITY_TYPE, UTILITY, BRAGA } from "../constants.ts";
import { proxyUtility, evolveWeight, leaseSeconds } from "./utility.ts";
import { publish } from "../lib/events.ts";

/**
 * Per-memory POST-act scoring snapshot, embedded in the on-chain CITATION
 * payload so the evolved tier + utility weight are cryptographically committed
 * to the anchored MMR root — not just held in the local SQLite mirror. This is
 * what makes the Darwinian state verifiable from chain and reconstructable
 * after the mirror is deleted (see src/darwinian/score-replay.ts).
 */
export interface CitationScore {
  key: Hex;
  tier: "observation" | "episode" | "rule";
  /** Evolved SEDM utility weight after this act. */
  weight: number;
  /** Cumulative citation count after this act. */
  citationCount: number;
}

/**
 * Per-cited-memory "decay receipt" returned from act() so the agent can
 * self-narrate the Darwinian effect of its decision ("reused X → +24h queued,
 * lease ~3d, weight 1.0→1.32"). Honest by construction:
 *   - `deltaSecondsThisCite` is REAL — deployed Braga extend is additive, so this
 *     is the exact lease gain this citation queues.
 *   - `projectedLeaseSeconds`/`projectedExpiresAtBlock` are an ESTIMATE (the extend
 *     is enqueued, not yet anchored), flagged via `estimated`. NEVER render a tx
 *     hash here — the on-chain extend doesn't exist until the worker drains the
 *     outbox; `outboxId` on ActResult is the only real provenance handle.
 */
export interface CitationReceipt {
  /** `cortex://<entityKey>` — stable, citable id for the memory. */
  id: string;
  key: Hex;
  /** Lease seconds ADDED by this citation (additive precompile → real gain). */
  deltaSecondsThisCite: number;
  /** Estimated total lease after this cite = remaining + pending + delta. */
  projectedLeaseSeconds: number;
  projectedExpiresAtBlock: number;
  tier: "observation" | "episode" | "rule";
  /** Evolved utility weight, committed this turn (not an estimate). */
  weightAfter: number;
  citationCountAfter: number;
  /** Outcome signal applied to the utility math (opts.outcome ?? default). */
  outcomeApplied: number;
  /** true when no chain-confirmed expiry baseline existed (projection is rougher). */
  estimated: boolean;
}

export interface ActResult {
  action: string;
  /** Citations that survived the lastRecallIds check. */
  citations: Hex[];
  /** Memories whose lifespan WILL be extended once the worker drains the bundle. */
  extendedKeys: Hex[];
  /** Per-cited-memory decay receipt (id, lease delta/projection, tier, weight). */
  receipts: CitationReceipt[];
  /** Memories that crossed a tier threshold this turn (already marked locally). */
  promotedKeys: Hex[];
  /**
   * Optimistic buffering outcome:
   *   - "queued": local scoring committed; on-chain work enqueued to the outbox.
   *   - "noop":   no citation survived the recall check — nothing enqueued.
   */
  status: "queued" | "noop";
  /** Outbox row id for the enqueued `act_bundle`; `null` when status is "noop". */
  outboxId: number | null;
  /**
   * keccak256 of the exact CITATION payload bytes — the MMR leaf the worker will
   * append + anchor. `null` when status is "noop". This is what binds the evolved
   * Darwinian scores to the anchored root once the bundle drains (score-replay.ts).
   */
  citationPayloadHashHex: Hex | null;
}

export interface ActOptions {
  action: string;
  citations: Hex[];
  /** User's primary EOA — required for tier-promotion ownership transfer. */
  userPrimaryEOA: Hex;
  /** Logical session id — used to track distinct sessions for semantic promotion. */
  sessionId?: string;
  /**
   * Optional outcome signal in [0,1] for the cited memories' utility (SEDM
   * proxy). 1 = the decision succeeded, 0 = failed, omitted = unknown (0.5).
   */
  outcome?: number;
  /** Override seam for tests — see tests/darwinian-citation.test.ts. */
  _deps?: ActDeps;
}

export interface ActDeps {
  /** Used to validate citations. Default: getLastRecallIds(). */
  lastRecallIds?: () => Set<Hex>;
  /** SQLite mirror — default: initMirrorDb(). The outbox lives here too. */
  db?: Database;
  /** Mirror lookup — returns entityType for a key if known. */
  entityTypeOf?: (entityKey: Hex) => "observation" | "episode" | "rule" | undefined;
}

/**
 * Read the cached entityType for an entity:
 *   1. citation_counts.entity_type if we've recorded it before
 *   2. else parse attributes_json from the entities mirror row and read the
 *      `entityType` attribute key.
 * Returns undefined if we haven't observed it yet.
 */
function defaultEntityTypeOf(
  db: Database,
  entityKey: Hex,
): "observation" | "episode" | "rule" | undefined {
  const cached = db
    .prepare("SELECT entity_type FROM citation_counts WHERE entity_key = ?")
    .get(entityKey) as { entity_type: string | null } | null;
  if (cached?.entity_type) {
    if (
      cached.entity_type === ENTITY_TYPE.OBSERVATION ||
      cached.entity_type === ENTITY_TYPE.EPISODE ||
      cached.entity_type === ENTITY_TYPE.RULE
    ) {
      return cached.entity_type;
    }
  }
  const mirror = db
    .prepare("SELECT attributes_json FROM entities WHERE entity_key = ?")
    .get(entityKey) as { attributes_json: string | null } | null;
  if (!mirror?.attributes_json) return undefined;
  try {
    const attrs = JSON.parse(mirror.attributes_json) as Array<{
      key: string;
      value: string | number;
    }>;
    for (const a of attrs) {
      if (a.key === "entityType") {
        if (a.value === ENTITY_TYPE.OBSERVATION) return "observation";
        if (a.value === ENTITY_TYPE.EPISODE) return "episode";
        if (a.value === ENTITY_TYPE.RULE) return "rule";
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

interface CitationRow {
  count: number;
  distinct_sessions: number;
  last_session_id: string | null;
  entity_type: string | null;
  promoted_to: string | null;
}

/**
 * Increment the per-entity citation counters atomically. Returns the new row so
 * callers can decide on tier promotion without a second SELECT.
 */
function bumpCitationCount(
  db: Database,
  entityKey: Hex,
  sessionId: string,
  entityType: string | undefined,
): CitationRow {
  const nowMs = Date.now();

  db.prepare(
    "INSERT INTO citation_counts (entity_key, count, distinct_sessions, last_session_id, last_cited_ms, entity_type) " +
      "VALUES (?, 0, 0, NULL, ?, ?) ON CONFLICT(entity_key) DO NOTHING",
  ).run(entityKey, nowMs, entityType ?? null);

  // Bump distinct_sessions only if (session_id, entity_key) is new.
  const insertSession = db.prepare(
    "INSERT INTO citation_sessions (session_id, entity_key, first_cited_ms) VALUES (?, ?, ?) " +
      "ON CONFLICT(session_id, entity_key) DO NOTHING",
  );
  const sessionResult = insertSession.run(sessionId, entityKey, nowMs);
  const sessionIsNew = sessionResult.changes > 0;

  db.prepare(
    "UPDATE citation_counts SET count = count + 1, last_session_id = ?, last_cited_ms = ?, " +
      "distinct_sessions = distinct_sessions + ? , entity_type = COALESCE(entity_type, ?) " +
      "WHERE entity_key = ?",
  ).run(sessionId, nowMs, sessionIsNew ? 1 : 0, entityType ?? null, entityKey);

  const row = db
    .prepare(
      "SELECT count, distinct_sessions, last_session_id, entity_type, promoted_to FROM citation_counts WHERE entity_key = ?",
    )
    .get(entityKey) as CitationRow | null;
  if (!row) {
    throw new Error(
      `bumpCitationCount: row missing after upsert for ${entityKey.slice(0, 10)}…`,
    );
  }
  return row;
}

/** Mark a memory as promoted to a higher tier so subsequent acts don't re-promote. */
function markPromoted(
  db: Database,
  entityKey: Hex,
  promotedTo: "episode" | "rule",
): void {
  db.prepare(
    "UPDATE citation_counts SET promoted_to = ? WHERE entity_key = ?",
  ).run(promotedTo, entityKey);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record an agent action with its citations. See file-header docs.
 *
 * Hallucination defense: any citation not in the most recent `getLastRecallIds`
 * set is dropped (console.warn). This keeps the tier-count statistics honest —
 * an LLM that invents memory IDs to look smart cannot inflate the system.
 */
export async function act(opts: ActOptions): Promise<ActResult> {
  if (typeof opts.action !== "string" || opts.action.length === 0) {
    throw new Error("act: action must be a non-empty string");
  }
  if (!Array.isArray(opts.citations)) {
    throw new Error("act: citations must be an array");
  }

  const sessionId = opts.sessionId ?? "default-session";
  const lastIdsFn = opts._deps?.lastRecallIds ?? getLastRecallIds;
  const db = opts._deps?.db ?? (await initMirrorDb());
  const entityTypeOf =
    opts._deps?.entityTypeOf ??
    ((entityKey: Hex) => defaultEntityTypeOf(db, entityKey));

  // 1. Validate citations against last recall set.
  const allowed = lastIdsFn();
  const validCitations: Hex[] = [];
  for (const c of opts.citations) {
    if (allowed.has(c)) validCitations.push(c);
    else
      console.warn(
        `act: dropping hallucinated citation ${c.slice(0, 10)}… (not in last recall)`,
      );
  }

  if (validCitations.length === 0) {
    return {
      action: opts.action,
      citations: [],
      extendedKeys: [],
      receipts: [],
      promotedKeys: [],
      status: "noop",
      outboxId: null,
      citationPayloadHashHex: null,
    };
  }

  // 2. Bump counts + decide reinforcement amount per citation.
  // Episodes get bigger reinforcement, observations get the baseline.
  const reinforceItems: { entityKey: Hex; reinforcementSeconds: number }[] = [];
  const promotionsToEpisode: Hex[] = [];
  const promotedToSemantic: Hex[] = [];

  // SEDM-fusion inputs for the proxy utility (free — already in hand).
  const recallRanks = getLastRecallRanks();
  const recallK = getLastRecallK();
  const citationCount = validCitations.length;

  // Decay-receipt baseline (read ONCE, BEFORE this act enqueues its own bundle).
  // headBlock = local mirror's last processed block (no RPC). pendingByKey sums
  // PRIOR in-flight extends not yet anchored, so the projected lease folds in
  // additive Braga semantics without double-counting THIS cite's delta (which is
  // added separately below). Must precede the enqueueOutbox call at the end.
  const headBlock = Number(getDaemonState(db, "last_processed_block") ?? "0");
  const blockTime = BRAGA.blockTimeSeconds;
  const pendingByKey = new Map<Hex, number>();
  for (const ob of listPendingOutbox(db, 500)) {
    for (const it of ob.bundle.reinforceItems) {
      const k = it.entityKey as Hex;
      pendingByKey.set(k, (pendingByKey.get(k) ?? 0) + it.reinforcementSeconds);
    }
  }

  for (const entityKey of validCitations) {
    const cachedType = entityTypeOf(entityKey);

    // Capture PRIOR state BEFORE bump: established weight (drives this lease)
    // + recency (drives the proxy utility for the NEXT lease).
    const priorWeight = getMemoryWeight(db, entityKey, UTILITY.wInit);
    const prevRow = db
      .prepare("SELECT last_cited_ms FROM citation_counts WHERE entity_key = ?")
      .get(entityKey) as { last_cited_ms: number } | null;
    const nowMs = Date.now();
    const msSinceLastCite = prevRow ? nowMs - prevRow.last_cited_ms : Infinity;

    const row = bumpCitationCount(db, entityKey, sessionId, cachedType);
    const tier =
      (row.entity_type as "observation" | "episode" | "rule" | null) ?? cachedType ?? "observation";

    // SEDM proxy utility Û → evolve the weight for FUTURE leases/recall.
    const uHat = proxyUtility({
      msSinceLastCite,
      citationCount,
      rank: recallRanks.get(entityKey),
      k: recallK > 0 ? recallK : 1,
      ...(opts.outcome !== undefined ? { outcome: opts.outcome } : {}),
    });
    const nextWeight = evolveWeight(priorWeight, uHat, 1);
    setMemoryWeight(db, entityKey, nextWeight, nowMs);

    // Rules are terminal — citing a rule extends it but doesn't promote it further.
    // Base lease by tier, then scale by the memory's PRIOR (established) weight:
    // a first/unproven citation (priorWeight = wInit) gets exactly base; proven
    // memories earn longer leases.
    const baseSeconds =
      tier === "episode" || row.promoted_to === "episode"
        ? REINFORCEMENT.episodicReinforcementSeconds
        : REINFORCEMENT.workingReinforcementSeconds;
    const reinforcementSeconds = leaseSeconds(baseSeconds, priorWeight);
    reinforceItems.push({ entityKey, reinforcementSeconds });

    // Tier promotion gates.
    if (
      tier === "observation" &&
      row.promoted_to === null &&
      row.count >= REINFORCEMENT.promoteToEpisodic
    ) {
      promotionsToEpisode.push(entityKey);
    }
    if (
      (tier === "episode" || row.promoted_to === "episode") &&
      row.promoted_to !== "rule" &&
      row.count >= REINFORCEMENT.promoteToSemantic &&
      row.distinct_sessions >= REINFORCEMENT.distinctSessionsForSemantic
    ) {
      promotedToSemantic.push(entityKey);
    }
  }

  // 3. Mark promotions locally (optimistic) — the on-chain ownership transfer
  // to the user EOA happens when the worker drains this bundle. Marking here
  // means a subsequent act() in the same fast loop sees promoted_to set and
  // won't re-enqueue the promotion.
  for (const k of promotionsToEpisode) markPromoted(db, k, "episode");

  // 4. Flag semantic-ready memories. The distill.ts cron picks these up.
  for (const k of promotedToSemantic) {
    // Idempotent — multiple acts can flag the same key before distill runs.
    db.prepare(
      "UPDATE citation_counts SET promoted_to = 'rule' WHERE entity_key = ? AND (promoted_to IS NULL OR promoted_to = 'episode')",
    ).run(k);
  }

  // 5. Live spine — one memory.cited per cited memory. Drives the Constellation
  // glow + (on promotion) the zone tween. Emitted optimistically: the local
  // scoring IS committed; the chain catches up via the worker.
  {
    const episodeSet = new Set<Hex>(promotionsToEpisode);
    const semanticSet = new Set<Hex>(promotedToSemantic);
    for (const item of reinforceItems) {
      const promotedTo = semanticSet.has(item.entityKey)
        ? ("rule" as const)
        : episodeSet.has(item.entityKey)
          ? ("episodic" as const)
          : undefined;
      publish({
        type: "memory.cited",
        ts: Date.now(),
        entityKey: item.entityKey,
        reinforcementSeconds: item.reinforcementSeconds,
        ...(promotedTo ? { promotedTo } : {}),
      });
    }
  }

  // 6. Build the on-chain CITATION payload carrying the POST-act scores, then
  // enqueue the whole on-chain bundle to the durable outbox. Scores are read
  // from citation_counts AFTER all promotions, so each cited memory's resulting
  // tier/weight/count is what the worker will anchor — binding the *evolved*
  // Darwinian state to the anchored MMR root (reconstructable after a mirror
  // wipe, see score-replay.ts). No chain call here: act() returns immediately.
  const citedRows = getCitationRows(db, validCitations);
  const scores: CitationScore[] = validCitations.map((key) => {
    const r = citedRows.get(key);
    const baseType = entityTypeOf(key);
    const tier: CitationScore["tier"] =
      r?.promotedTo === "rule" || baseType === "rule"
        ? "rule"
        : r?.promotedTo === "episode" || baseType === "episode"
          ? "episode"
          : "observation";
    return { key, tier, weight: r?.weight ?? UTILITY.wInit, citationCount: r?.count ?? 0 };
  });

  // Decay receipts: project each cited memory's resulting lease. delta is REAL
  // (additive precompile); the absolute projection is an estimate (extend still
  // queued). Projecting against the entity's CURRENT expiry — not headBlock —
  // honors additive semantics: head + remaining + delta == currentExpiry + delta.
  const reinforceByKey = new Map(reinforceItems.map((i) => [i.entityKey, i.reinforcementSeconds]));
  const baselineStmt = db.prepare("SELECT expires_at_block FROM entities WHERE entity_key = ?");
  // Sanity ceiling on a projected lease (project cap is 1 year). A projection
  // above this means the chain cursor is stale, NOT that the memory truly has a
  // multi-year lease — clamp + flag rather than print false precision.
  const SANE_MAX_LEASE_SECONDS = REINFORCEMENT.semanticInitialSeconds;
  const receipts: CitationReceipt[] = scores.map((s) => {
    const delta = reinforceByKey.get(s.key) ?? 0;
    const baseRow = baselineStmt.get(s.key) as { expires_at_block: number } | null;
    // A usable on-chain baseline needs a known expiry AND a real chain cursor
    // (headBlock). The plugin-first product runs no sync daemon, so headBlock is
    // often 0/stale; without it, (expires_at_block - headBlock) is meaningless
    // (expires_at_block is an absolute Braga block in the millions) and would
    // render an absurd multi-year lease as if confirmed. Fall back to the working
    // estimate, flagged, instead of printing false precision.
    const pendingSeconds = pendingByKey.get(s.key) ?? 0;
    let remainingSeconds: number;
    let estimated: boolean;
    if (baseRow && baseRow.expires_at_block > 0 && headBlock > 0) {
      const raw = Math.max(0, baseRow.expires_at_block - headBlock) * blockTime;
      remainingSeconds = Math.min(raw, SANE_MAX_LEASE_SECONDS);
      estimated = raw > SANE_MAX_LEASE_SECONDS; // clamped ⇒ cursor stale ⇒ flag it
    } else {
      remainingSeconds = REINFORCEMENT.initialWorkingSeconds;
      estimated = true; // no reliable chain baseline → projection is an estimate
    }
    const projectedLeaseSeconds = remainingSeconds + pendingSeconds + delta;
    return {
      id: `cortex://${s.key}`,
      key: s.key,
      deltaSecondsThisCite: delta,
      projectedLeaseSeconds,
      projectedExpiresAtBlock: headBlock + Math.round(projectedLeaseSeconds / blockTime),
      tier: s.tier,
      weightAfter: s.weight,
      citationCountAfter: s.citationCount,
      outcomeApplied: opts.outcome ?? UTILITY.defaultOutcome,
      estimated,
    };
  });

  const built = buildCitationPayload(opts.action, validCitations, scores);
  const bundle: OutboxBundle = {
    action: opts.action,
    citations: validCitations,
    reinforceItems,
    promotionsToEpisode,
    userPrimaryEOA: opts.userPrimaryEOA,
    citationPayloadHex: built.payloadHex,
    citationAttributes: built.attributes,
    citationPayloadHashHex: built.payloadHashHex,
  };
  const outboxId = enqueueOutbox(db, "act_bundle", bundle);

  const promotedKeys: Hex[] = [...promotionsToEpisode, ...promotedToSemantic];

  return {
    action: opts.action,
    citations: validCitations,
    extendedKeys: reinforceItems.map((i) => i.entityKey),
    receipts,
    promotedKeys,
    status: "queued",
    outboxId,
    citationPayloadHashHex: built.payloadHashHex,
  };
}

// ---------------------------------------------------------------------------
// Citation-payload builder (pure — no chain). Produces the EXACT bytes the
// anchor worker ships on-chain, their keccak256 (the MMR leaf), and the stamped
// attributes. act() puts payloadHex + hash + attributes into the outbox bundle;
// the worker reconstructs the bytes verbatim so the hash it anchors matches.
// Stamped attributes:
//   - entityType=citation (read by ui-server /api/decisions)
//   - action=<label>
//   - citationCount=<n>
//   - cite0..citeN-1=<entityKey.toLowerCase()>  (downstream join keys)
// PROJECT_ATTRIBUTE is added by the worker's singleCreate via stampProjectAttribute.
// ---------------------------------------------------------------------------

export function buildCitationPayload(
  action: string,
  citations: Hex[],
  scores: CitationScore[],
): {
  payloadHex: Hex;
  payloadHashHex: Hex;
  attributes: { key: string; value: string | number }[];
} {
  // `scores` carries the POST-act tier/weight/count per cited memory, so the
  // anchored root commits the evolved Darwinian state (verifiable +
  // chain-reconstructable). The hash is derived from the exact bytes shipped.
  const payload = jsonToPayload({
    action,
    citations,
    scores,
    observedAtMs: Date.now(),
  });
  return {
    payloadHex: bytesToHex(payload),
    payloadHashHex: bytesToHex(keccak256(payload, "bytes")),
    attributes: [
      { key: "entityType", value: ENTITY_TYPE.CITATION },
      { key: "action", value: action },
      { key: "citationCount", value: citations.length },
      ...citations.map((k, i) => ({ key: `cite${i}`, value: k.toLowerCase() })),
    ],
  };
}

// ---------------------------------------------------------------------------
// Read helpers — exposed for tests and the distillation cron.
// ---------------------------------------------------------------------------

export interface CitationStats {
  entityKey: Hex;
  count: number;
  distinctSessions: number;
  lastSessionId: string | null;
  entityType: string | null;
  promotedTo: string | null;
}

export async function getCitationStats(entityKey: Hex, db?: Database): Promise<CitationStats | null> {
  const conn = db ?? (await initMirrorDb());
  const row = conn
    .prepare(
      "SELECT entity_key, count, distinct_sessions, last_session_id, entity_type, promoted_to FROM citation_counts WHERE entity_key = ?",
    )
    .get(entityKey) as
    | {
        entity_key: Hex;
        count: number;
        distinct_sessions: number;
        last_session_id: string | null;
        entity_type: string | null;
        promoted_to: string | null;
      }
    | null;
  if (!row) return null;
  return {
    entityKey: row.entity_key,
    count: row.count,
    distinctSessions: row.distinct_sessions,
    lastSessionId: row.last_session_id,
    entityType: row.entity_type,
    promotedTo: row.promoted_to,
  };
}

/** Used by distill.ts to find episodes ready for semantic promotion. */
export async function listSemanticReady(db?: Database): Promise<CitationStats[]> {
  const conn = db ?? (await initMirrorDb());
  const rows = conn
    .prepare(
      "SELECT entity_key, count, distinct_sessions, last_session_id, entity_type, promoted_to " +
        "FROM citation_counts WHERE promoted_to = 'rule'",
    )
    .all() as Array<{
    entity_key: Hex;
    count: number;
    distinct_sessions: number;
    last_session_id: string | null;
    entity_type: string | null;
    promoted_to: string | null;
  }>;
  return rows.map((r) => ({
    entityKey: r.entity_key,
    count: r.count,
    distinctSessions: r.distinct_sessions,
    lastSessionId: r.last_session_id,
    entityType: r.entity_type,
    promotedTo: r.promoted_to,
  }));
}
