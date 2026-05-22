/**
 * Cortex — act() / citation tracker.
 *
 * The agent has exactly two memory tools (CLAUDE.md "Citation-driven reinforcement"):
 *   - recall(query, k)
 *   - act(action, citations)
 *
 * Every act() call:
 *   1. Validates citations against the last recall set (hallucinations dropped).
 *   2. Increments per-memory citation counts in bun:sqlite.
 *   3. Fires accumulative `reinforceBatch` on the surviving citations.
 *   4. Promotes any memory that crossed the working→episodic threshold:
 *        - bumps its lifespan by REINFORCEMENT.episodicReinforcementSeconds
 *        - transfers ownership from session key → user EOA so the long-lived
 *          memory survives session-key death (see lib/ownership.ts).
 *   5. Flags any memory ready for semantic distillation. The actual LLM call
 *      runs in darwinian/distill.ts (kept separate so act() stays fast — the
 *      distill happens out of the synchronous decision path).
 *
 * Citation tracking lives in the SQLite mirror (citation_counts + citation_sessions
 * tables — see mirror/schema.sql). The sqlite-side counters are the source of
 * truth for tier promotions; the Arkiv-side lifespan is the source of truth for
 * "is this memory still alive?".
 */

import type { Database } from "bun:sqlite";
import type { Hex } from "@arkiv-network/sdk";
import { jsonToPayload, ExpirationTime } from "@arkiv-network/sdk/utils";
import { keccak256, bytesToHex } from "viem";
import { initMirrorDb, setPayloadHash } from "../mirror/db.ts";
import { reinforceBatch, type ReinforceBatchDeps } from "./extend.ts";
import { promoteOwnership } from "../lib/ownership.ts";
import { getLastRecallIds } from "./recall.ts";
import { singleCreate } from "../lib/batch-writer.ts";
import { REINFORCEMENT, ENTITY_TYPE } from "../constants.ts";
import { appendToStateMMR } from "../mirror/state.ts";
import { commitAndAnchor, type StateRootAnchorResult } from "../mirror/anchor.ts";
import { publish } from "../lib/events.ts";

export interface ActResult {
  action: string;
  /** Citations that survived the lastRecallIds check. */
  citations: Hex[];
  /** Memories whose Arkiv lifespan was extended this turn. */
  extendedKeys: Hex[];
  /** Memories that crossed a tier threshold this turn. */
  promotedKeys: Hex[];
  /** Tx hashes for extends + ownership transfers + state-root anchor. */
  txHashes: string[];
  /**
   * Entity key of the on-chain CITATION entity written for this act() call.
   * `null` if there were no valid citations (nothing was written) or if the
   * write failed (warning logged; we don't fail act() over an audit row).
   */
  citationEntityKey: Hex | null;
  /**
   * Phase 13 — the MMR state-root snapshot committed for this decision.
   * `null` when the citation write failed (no state to commit) or when the
   * anchor broadcast failed (commit row still inserted locally).
   */
  stateRootAnchor: StateRootAnchorResult | null;
}

export interface ActOptions {
  action: string;
  citations: Hex[];
  /** User's primary EOA — required for tier-promotion ownership transfer. */
  userPrimaryEOA: Hex;
  /** Logical session id — used to track distinct sessions for semantic promotion. */
  sessionId?: string;
  /** Override seam for tests — see tests/darwinian-citation.test.ts. */
  _deps?: ActDeps;
}

export interface ActDeps {
  /** Used to validate citations. Default: getLastRecallIds(). */
  lastRecallIds?: () => Set<Hex>;
  /** SQLite mirror — default: initMirrorDb(). */
  db?: Database;
  /** Reinforce-batch override. */
  reinforce?: (
    items: { entityKey: Hex; reinforcementSeconds: number }[],
  ) => Promise<string>;
  /** Ownership-promote override. */
  promote?: (entityKeys: readonly Hex[], userEOA: Hex) => Promise<{ txHash: string }>;
  /** Mirror lookup — returns entityType for a key if known. */
  entityTypeOf?: (entityKey: Hex) => "observation" | "episode" | "rule" | undefined;
  /**
   * Override for the on-chain CITATION-entity write. Default: singleCreate().
   * Tests can stub this to avoid touching Braga.
   */
  writeCitationEntity?: (input: {
    action: string;
    citations: Hex[];
  }) => Promise<{
    entityKey: Hex;
    txHash: string;
    /**
     * Optional in the test seam — when present, act() will append the hash
     * to the in-process MMR and commit+anchor a state-root. Production path
     * (`defaultWriteCitationEntity`) always returns it; tests that don't
     * care about MMR side effects can omit it.
     */
    payloadHashHex?: Hex;
  }>;
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
  const reinforce =
    opts._deps?.reinforce ??
    (async (items) => reinforceBatch(items));
  const promote =
    opts._deps?.promote ??
    (async (keys, eoa) => {
      const result = await promoteOwnership(keys, eoa);
      return { txHash: result.txHash };
    });
  const entityTypeOf =
    opts._deps?.entityTypeOf ??
    ((entityKey: Hex) => defaultEntityTypeOf(db, entityKey));
  const writeCitationEntity =
    opts._deps?.writeCitationEntity ?? defaultWriteCitationEntity;

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
      promotedKeys: [],
      txHashes: [],
      citationEntityKey: null,
      stateRootAnchor: null,
    };
  }

  // Tx hashes accumulate across the citation-entity write, the reinforce batch,
  // and any ownership promotion. Declared early so 1a can push into it.
  const txHashes: string[] = [];

  // 1a. Write the on-chain CITATION entity BEFORE firing extends. This is the
  // audit row the UI's /api/decisions endpoint surfaces. Failure here logs a
  // warning but does not abort act() — the reinforcement is the load-bearing
  // economic effect; the citation row is the readable record.
  let citationEntityKey: Hex | null = null;
  let stateRootAnchor: StateRootAnchorResult | null = null;
  try {
    const writeResult = await writeCitationEntity({
      action: opts.action,
      citations: validCitations,
    });
    citationEntityKey = writeResult.entityKey;
    txHashes.push(writeResult.txHash);

    // Phase 13 — Merkleized state anchor.
    // After the citation entity lands, append its payload hash to THIS
    // process's MMR singleton (the daemon's MMR catches up asynchronously
    // via its hydrate hook), then commit + anchor the new root to Arkiv.
    //
    // We append explicitly here (rather than relying on daemon hydrate)
    // because the agent runtime and the daemon are typically separate
    // processes. The agent process needs its MMR to reflect THIS new
    // citation before computing the root to anchor.
    //
    // If writeCitationEntity exposed the payload hash, use it; otherwise
    // we skip (test stubs may not return it). Real production paths set it.
    if (writeResult.payloadHashHex) {
      try {
        setPayloadHash(db, writeResult.entityKey, writeResult.payloadHashHex);
        await appendToStateMMR(writeResult.payloadHashHex);
        stateRootAnchor = await commitAndAnchor("act");
        txHashes.push(stateRootAnchor.txHash);
      } catch (err) {
        console.warn(
          `act: state-root anchor failed — ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  } catch (err) {
    console.warn(
      `act: writeCitationEntity failed — ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 2. Bump counts + decide reinforcement amount per citation.
  // Episodes get bigger reinforcement, observations get the baseline.
  const reinforceItems: { entityKey: Hex; reinforcementSeconds: number }[] = [];
  const promotionsToEpisode: Hex[] = [];
  const promotedToSemantic: Hex[] = [];

  for (const entityKey of validCitations) {
    const cachedType = entityTypeOf(entityKey);
    const row = bumpCitationCount(db, entityKey, sessionId, cachedType);
    const tier =
      (row.entity_type as "observation" | "episode" | "rule" | null) ?? cachedType ?? "observation";

    // Rules are terminal — citing a rule extends it but doesn't promote it further.
    const reinforcementSeconds =
      tier === "episode" || row.promoted_to === "episode"
        ? REINFORCEMENT.episodicReinforcementSeconds
        : REINFORCEMENT.workingReinforcementSeconds;
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

  // 3. Fire the accumulative extend batch.
  let reinforceSucceeded = false;
  try {
    const txHash = await reinforce(reinforceItems);
    txHashes.push(txHash);
    reinforceSucceeded = true;
  } catch (err) {
    console.warn(
      `act: reinforceBatch failed — ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 3a. Live spine — one memory.cited per reinforced memory. Drives the
  // Constellation glow + (on promotion) the zone tween. Only emitted when the
  // reinforce actually landed, so the dashboard never animates a non-event.
  if (reinforceSucceeded) {
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

  // 4. Promote working → episodic (ownership transfer to user EOA).
  if (promotionsToEpisode.length > 0) {
    try {
      const result = await promote(promotionsToEpisode, opts.userPrimaryEOA);
      txHashes.push(result.txHash);
      for (const k of promotionsToEpisode) markPromoted(db, k, "episode");
    } catch (err) {
      console.warn(
        `act: promoteOwnership(working→episodic) failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 5. Flag semantic-ready memories. The distill.ts cron picks these up.
  for (const k of promotedToSemantic) {
    // Idempotent — multiple acts can flag the same key before distill runs.
    db.prepare(
      "UPDATE citation_counts SET promoted_to = 'rule' WHERE entity_key = ? AND (promoted_to IS NULL OR promoted_to = 'episode')",
    ).run(k);
  }

  const promotedKeys: Hex[] = [...promotionsToEpisode, ...promotedToSemantic];

  return {
    action: opts.action,
    citations: validCitations,
    extendedKeys: reinforceItems.map((i) => i.entityKey),
    promotedKeys,
    txHashes,
    citationEntityKey,
    stateRootAnchor,
  };
}

// ---------------------------------------------------------------------------
// Default citation-entity writer — production path lives in lib/batch-writer.
// Stamped attributes:
//   - entityType=citation (read by ui-server /api/decisions)
//   - action=<label>
//   - citationCount=<n>
//   - cite0..citeN-1=<entityKey.toLowerCase()>  (downstream join keys)
// PROJECT_ATTRIBUTE is added by singleCreate via stampProjectAttribute.
// ---------------------------------------------------------------------------

async function defaultWriteCitationEntity(input: {
  action: string;
  citations: Hex[];
}): Promise<{ entityKey: Hex; txHash: string; payloadHashHex: Hex }> {
  // Compute the payload bytes FIRST so we can hash them before the SDK call.
  // The hash is what the MMR commits to — it must be derived from the exact
  // bytes we ship on-chain, not from a re-serialised view.
  const payload = jsonToPayload({
    action: input.action,
    citations: input.citations,
    observedAtMs: Date.now(),
  });
  const payloadHashHex = bytesToHex(keccak256(payload, "bytes"));

  const { entityKey, txHash } = await singleCreate({
    payload,
    contentType: "application/json",
    attributes: [
      { key: "entityType", value: ENTITY_TYPE.CITATION },
      { key: "action", value: input.action },
      { key: "citationCount", value: input.citations.length },
      ...input.citations.map((k, i) => ({
        key: `cite${i}`,
        value: k.toLowerCase(),
      })),
    ],
    expiresInSeconds: ExpirationTime.fromDays(30),
  });
  return { entityKey, txHash, payloadHashHex };
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
