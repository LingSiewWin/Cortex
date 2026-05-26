/**
 * Cortex — manual citation endpoint (Phase 16).
 *
 * POST /api/citation/manual { query }
 *
 * The judge-typed "Cite" path. Runs the SAME shared cite cycle the autonomous
 * loop uses (src/agent/citation-cycle.ts), so the dashboard animates
 * identically. Because this runs INSIDE the dashboard server process, the
 * events it publishes reach the /sse stream and light up every surface.
 *
 * Optimistic buffering: a cite commits scoring locally and enqueues the
 * on-chain work to the outbox, so this returns immediately with a queue id —
 * the tx hashes + citation entity key arrive later via the anchor worker.
 *
 * Responses:
 *   200 { query, candidateCount, selected, cited, status, outboxId, citationPayloadHashHex }
 *   400 invalid body
 *   402 allowance exhausted / insufficient funds
 *   500 unexpected
 */

import type { Hex } from "@arkiv-network/sdk";
import { runCiteCycle, type CiteCycleResult } from "../agent/citation-cycle";
import { getUserPrimaryEOA } from "../lib/arkiv-client";
import {
  checkManualAllowed,
  markManualCite,
  recordSpend,
  type SpendDecision,
} from "../agent/spend-guard";

/** Conservative gas estimate for one manual cite (create + extend + anchor ≈ 3 tx). */
const MANUAL_EST_COST_WEI = 120_000_000_000_000n;
/** Max accepted request body + query length (the query is written on-chain). */
const MAX_BODY_BYTES = 4096;
const MAX_QUERY_LEN = 256;

/** Clamp + strip control chars from an attacker-supplied query before it is
 *  embedded, broadcast over SSE, and written on-chain under our session key.
 *  Uses charCode filtering (not a regex) to avoid control chars in source. */
function sanitizeQuery(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return out.trim().slice(0, MAX_QUERY_LEN);
}

export interface ManualCitationDeps {
  /** Override the cite cycle (tests). Default: real runCiteCycle. */
  runCycle?: (opts: {
    query: string;
    userPrimaryEOA: Hex;
    actionLabel?: string;
    sessionId?: string;
  }) => Promise<CiteCycleResult>;
  /** Override the EOA resolver (tests). Default: getUserPrimaryEOA(). */
  getUserEOA?: () => Hex;
  /** Override the spend gate (tests). Default: real shared spend guard. */
  checkSpend?: (estCostWei: bigint) => SpendDecision;
}

function json(status: number, body: unknown): Response {
  const text = JSON.stringify(body, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
  return new Response(text, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export async function handleManualCitation(
  req: Request,
  deps?: ManualCitationDeps,
  ip = "global",
): Promise<Response> {
  // Reject oversized bodies before parsing (memory-pressure DoS guard).
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return json(413, { error: "request body too large" });
  }

  let body: { query?: unknown } | null;
  try {
    body = (await req.json()) as { query?: unknown };
  } catch {
    return json(400, { error: "invalid JSON body" });
  }
  const rawQuery = body?.query;
  if (typeof rawQuery !== "string" || rawQuery.trim().length === 0) {
    return json(400, { error: "query (non-empty string) required" });
  }
  // Clamp + strip control chars — this string is embedded, broadcast over SSE
  // to every viewer, and written on-chain under our session key.
  const query = sanitizeQuery(rawQuery);
  if (query.length === 0) {
    return json(400, { error: "query is empty after sanitization" });
  }

  let userPrimaryEOA: Hex;
  try {
    userPrimaryEOA = (deps?.getUserEOA ?? getUserPrimaryEOA)();
  } catch (err) {
    return json(500, {
      error: `USER_PRIMARY_ADDRESS not configured: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }

  // Runaway-spend backstop: this endpoint is unauthenticated, so gate it on a
  // shared session cap + per-IP rate-limit BEFORE touching the wallet.
  const gate = (deps?.checkSpend ?? ((c: bigint) => checkManualAllowed(c, ip)))(
    MANUAL_EST_COST_WEI,
  );
  if (!gate.ok) {
    return json(gate.status ?? 429, { error: gate.reason ?? "spend not allowed" });
  }

  const runCycle =
    deps?.runCycle ??
    ((o) =>
      runCiteCycle({
        query: o.query,
        userPrimaryEOA: o.userPrimaryEOA,
        actionLabel: o.actionLabel ?? "manual",
        sessionId: o.sessionId ?? "manual-citation",
      }));

  try {
    const cycle = await runCycle({
      query,
      userPrimaryEOA,
      actionLabel: "manual",
      sessionId: "manual-citation",
    });
    // Charge the session only when a cite actually fired (act ran).
    if (cycle.act !== null && !deps?.checkSpend) {
      markManualCite(ip);
      recordSpend(MANUAL_EST_COST_WEI);
    }
    return json(200, {
      query: cycle.query,
      candidateCount: cycle.hits.length,
      selected: cycle.selected,
      cited: cycle.act !== null,
      // Optimistic: on-chain work is queued; the worker anchors it shortly.
      status: cycle.act?.status ?? "noop",
      outboxId: cycle.act?.outboxId ?? null,
      citationPayloadHashHex: cycle.act?.citationPayloadHashHex ?? null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Allowance / funding failures surface as 402 Payment Required so the
    // widget can show "agent out of budget" rather than a generic error.
    if (/allowance|insufficient[_\s]?funds|payment\s?required|over\s?cap/i.test(msg)) {
      return json(402, { error: msg });
    }
    return json(500, { error: msg });
  }
}
