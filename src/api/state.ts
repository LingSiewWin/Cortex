/**
 * Cortex — `/api/state/*` endpoints (Phase 12 read API + Phase 13 write).
 *
 * Phase 12 (this file):
 *   GET  /api/state/root          → current MMR root + leaf count + last commits
 *   POST /api/state/commit        → take a snapshot, insert a state_roots row
 *
 * Phase 13 will add:
 *   POST /api/state/anchor        → broadcast the most-recent uncommitted
 *                                   root to Arkiv as a state_root entity
 */

import type { Hex } from "viem";
import {
  commitStateRoot,
  getRecentStateRoots,
  getStateMMR,
} from "../mirror/state";
import { anchorPendingStateRoot, commitAndAnchor } from "../mirror/anchor";
import { initMirrorDb, listLeafHashesInOrder } from "../mirror/db";
import { verifyMMRProof, type MMRProof } from "../mirror/mmr";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorJson(status: number, error: string): Response {
  return json({ error }, status);
}

async function safeJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const ct = req.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) return null;
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface StateRootResponse {
  currentRoot: Hex;
  leafCount: number;
  isEmpty: boolean;
  recentCommits: Array<{
    id: number;
    rootHex: Hex;
    leafCount: number;
    computedAtMs: number;
    triggerReason: string;
    anchoredTxHash: Hex | null;
    anchoredAtBlock: number | null;
    anchoredEntityKey: Hex | null;
  }>;
}

export async function handleStateRootRequest(
  _req: Request,
): Promise<Response> {
  const mmr = await getStateMMR();
  const recent = await getRecentStateRoots(20);
  const body: StateRootResponse = {
    currentRoot: mmr.getRootHex(),
    leafCount: mmr.size(),
    isEmpty: mmr.size() === 0,
    recentCommits: recent.map((r) => ({
      id: r.id,
      rootHex: r.root_hex,
      leafCount: r.leaf_count,
      computedAtMs: r.computed_at_ms,
      triggerReason: r.trigger_reason,
      anchoredTxHash: r.anchored_tx_hash,
      anchoredAtBlock: r.anchored_at_block,
      anchoredEntityKey: r.anchored_entity_key,
    })),
  };
  return json(body);
}

export async function handleStateCommitRequest(
  req: Request,
): Promise<Response> {
  const body = await safeJson(req);
  const triggerReason =
    body && typeof body.triggerReason === "string"
      ? body.triggerReason
      : "manual";
  if (!["manual", "act", "periodic", "boot"].includes(triggerReason)) {
    return errorJson(
      400,
      `triggerReason must be one of manual|act|periodic|boot; got ${triggerReason}`,
    );
  }
  const result = await commitStateRoot(
    triggerReason as "manual" | "act" | "periodic" | "boot",
  );
  return json({ ok: true, ...result });
}

/**
 * POST /api/state/anchor — broadcast the most-recent uncommitted state root
 * to Arkiv. Idempotent on root_hex. Body is optional; pass
 * `{ andCommit: true, triggerReason: "manual" }` to first commit a fresh
 * snapshot of the current MMR root, then broadcast it.
 */
export async function handleStateAnchorRequest(
  req: Request,
): Promise<Response> {
  const body = await safeJson(req);
  const andCommit = body && body.andCommit === true;
  const triggerReason =
    body && typeof body.triggerReason === "string"
      ? body.triggerReason
      : "manual";
  if (
    andCommit &&
    !["manual", "act", "periodic", "boot"].includes(triggerReason)
  ) {
    return errorJson(
      400,
      `triggerReason must be one of manual|act|periodic|boot; got ${triggerReason}`,
    );
  }

  if (andCommit) {
    const result = await commitAndAnchor(
      triggerReason as "manual" | "act" | "periodic" | "boot",
    );
    return json({ ok: true, ...result });
  }

  const result = await anchorPendingStateRoot();
  if (!result) {
    return json({ ok: true, message: "nothing to anchor — all roots current" });
  }
  return json({ ok: true, ...result });
}

// ---------------------------------------------------------------------------
// Proof playground (Phase 13.5)
// ---------------------------------------------------------------------------

export interface StateProofResponse {
  found: boolean;
  /** Why we couldn't produce a proof — only set when found=false. */
  reason?: string;
  leafIndex: number | null;
  leafCount: number;
  proof: MMRProof | null;
  /** Server-side verification of its own proof. Should always be true if
   *  found=true; if it's ever false the MMR has a bug we need to know about. */
  verified: boolean;
  currentRoot: Hex;
}

/**
 * POST /api/state/proof — given an entity key, return its MMR inclusion proof
 * plus a server-side verifyMMRProof check. The client can ALSO run
 * verifyMMRProof on the returned proof to confirm (proves end-to-end
 * verification doesn't require trusting the server).
 *
 * Returns 200 with found=false when:
 *   - the entity isn't a Cortex memory (state_root / listing / grant / unknown)
 *   - the entity is known but its payload_hash hasn't been computed yet
 *
 * 200 with found=true and verified=true is the success case.
 */
export async function handleStateProofRequest(
  req: Request,
): Promise<Response> {
  const body = await safeJson(req);
  if (!body || typeof body.entityKey !== "string") {
    return errorJson(400, "entityKey required");
  }
  const entityKey = body.entityKey as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(entityKey)) {
    return errorJson(400, "entityKey must be 0x-prefixed 32-byte hex");
  }

  const mmr = await getStateMMR();
  const currentRoot = mmr.getRootHex();
  const leafCount = mmr.size();

  // Find leaf index: linear scan of the canonical MMR insertion order.
  // For demo scale (≤10k leaves) this is sub-millisecond. Production with
  // >100k leaves should switch to a SQL window-function query.
  const db = await initMirrorDb();
  const leaves = listLeafHashesInOrder(db);
  const target = entityKey.toLowerCase();
  const leafIndex = leaves.findIndex(
    (l) => l.entityKey.toLowerCase() === target,
  );

  if (leafIndex === -1) {
    return json({
      found: false,
      reason:
        "Entity is not in the MMR. Possible reasons: it's a state_root / listing / grant " +
        "(excluded by design), or it hasn't been hydrated by the mirror daemon yet.",
      leafIndex: null,
      leafCount,
      proof: null,
      verified: false,
      currentRoot,
    } satisfies StateProofResponse);
  }

  const proof = mmr.getProof(leafIndex);
  const verified = verifyMMRProof(proof);
  return json({
    found: true,
    leafIndex,
    leafCount,
    proof,
    verified,
    currentRoot,
  } satisfies StateProofResponse);
}
