/**
 * Cortex — Agent Allowance API handlers.
 *
 * Implements the "parent sets a monthly allowance for the AI child" pattern
 * sketched in docs/ERC.md §3.5 (the workaround for the missing
 * ERC-7715 DelegationManager on Braga).
 *
 * The master signs a `SessionAuthorizationV2` granting a session-key EOA:
 *   - a cumulative GLM ceiling (maxGasWei)
 *   - a write count cap (maxWrites)
 *   - a refill threshold (refillThresholdWei — dashboard alert level)
 *   - a projected daily-cost (estimatedDailyCostWei — display-only)
 *   - a validBefore expiry
 *
 * The relayer (this code) tracks cumulative spend per session in the
 * `agent_allowances` + `allowance_spends` tables and refuses writes once
 * the cap is hit. Refilling is a fresh signature with a new session key,
 * which marks the previous allowance as expired and chains the rows via
 * `refilled_from`.
 *
 * Pure handlers (Request → Response): wired by ui-server.ts, easy to test
 * with a fabricated Request. Bigint discipline: every wei field is bigint
 * in TypeScript and decimal-string on the wire.
 */

import type { Hex } from "@arkiv-network/sdk";
import { initMirrorDb } from "../mirror/db";
import {
  createAllowance,
  getAllowanceBySessionKey,
  getAllowancesByMaster,
  markExpired,
  recentSpends,
  recordSpend,
  type AllowanceRow,
  type AllowanceState,
} from "../mirror/db";
import type { SessionAuthorizationV2 } from "../lib/eip712";

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/**
 * Wire form of `SessionAuthorizationV2`. All uint256 fields ride as decimal
 * strings (JSON has no bigint type); the addresses + bytes32 fields are
 * `0x…` hex strings as usual.
 */
export interface SessionAuthorizationV2Wire {
  user: Hex;
  sessionKey: Hex;
  scope: Hex;
  entityNamespace: Hex;
  maxWrites: string;
  maxGasWei: string;
  refillThresholdWei: string;
  estimatedDailyCostWei: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}

export interface RecentSpendView {
  atMs: number;
  gasWei: string;
  txHash: Hex | null;
}

/**
 * The exact JSON shape returned by `handleGetAllowance`. Mirrored here as a
 * named interface so the frontend can import the type directly.
 */
export interface AllowanceSnapshot {
  sessionKey: Hex;
  master: Hex;
  scope: Hex;
  entityNamespace: Hex;
  maxWrites: number;
  writeCount: number;
  maxGasWei: string;
  spentWei: string;
  remainingWei: string;
  refillThresholdWei: string;
  estimatedDailyCostWei: string;
  /**
   * remainingWei / estimatedDailyCostWei, as a floating-point estimate.
   * `null` when estimatedDailyCostWei is 0 (avoid division-by-zero).
   * Capped at 9999 so the UI never has to render scientific notation.
   */
  runwayDays: number | null;
  validAfter: number;
  validBefore: number;
  state: AllowanceState;
  createdAtMs: number;
  lastSpendAtMs: number | null;
  refilledFrom: Hex | null;
  recentSpends: RecentSpendView[];
}

export interface CreateAllowanceBody {
  auth: SessionAuthorizationV2Wire;
  signature: Hex;
  signer: Hex;
}

export interface RefillAllowanceBody {
  prevSessionKey: Hex;
  newAuth: SessionAuthorizationV2Wire;
  newSignature: Hex;
  newSigner: Hex;
}

export interface RecordSpendBody {
  sessionKey: Hex;
  txHash?: Hex | null;
  gasWei: string;
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorJson(status: number, message: string): Response {
  return json({ error: message }, status);
}

async function readJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Wire-form parsing
// ---------------------------------------------------------------------------

function isHex(v: unknown): v is Hex {
  return typeof v === "string" && v.startsWith("0x");
}

function isDecimalString(v: unknown): v is string {
  return typeof v === "string" && /^\d+$/.test(v);
}

function parseAuthWire(v: unknown): SessionAuthorizationV2 | null {
  if (!v || typeof v !== "object") return null;
  const w = v as Record<string, unknown>;
  if (
    !isHex(w.user) ||
    !isHex(w.sessionKey) ||
    !isHex(w.scope) ||
    !isHex(w.entityNamespace) ||
    !isHex(w.nonce) ||
    !isDecimalString(w.maxWrites) ||
    !isDecimalString(w.maxGasWei) ||
    !isDecimalString(w.refillThresholdWei) ||
    !isDecimalString(w.estimatedDailyCostWei) ||
    !isDecimalString(w.validAfter) ||
    !isDecimalString(w.validBefore)
  ) {
    return null;
  }
  return {
    user: w.user,
    sessionKey: w.sessionKey,
    scope: w.scope,
    entityNamespace: w.entityNamespace,
    maxWrites: BigInt(w.maxWrites),
    maxGasWei: BigInt(w.maxGasWei),
    refillThresholdWei: BigInt(w.refillThresholdWei),
    estimatedDailyCostWei: BigInt(w.estimatedDailyCostWei),
    validAfter: BigInt(w.validAfter),
    validBefore: BigInt(w.validBefore),
    nonce: w.nonce,
  };
}

// ---------------------------------------------------------------------------
// Snapshot builder
// ---------------------------------------------------------------------------

const SECONDS_PER_DAY = 86_400n;
const MILLIWEI = 1_000n;

function computeRunwayDays(
  remainingWei: bigint,
  estimatedDailyCostWei: bigint,
): number | null {
  if (estimatedDailyCostWei <= 0n) return null;
  // Compute (remaining / daily) in milli-day precision so we don't lose
  // resolution to integer truncation, then convert to JS number.
  const milliDays = (remainingWei * MILLIWEI) / estimatedDailyCostWei;
  const days = Number(milliDays) / 1_000;
  if (!Number.isFinite(days)) return null;
  if (days > 9_999) return 9_999;
  if (days < 0) return 0;
  return days;
}

async function buildSnapshot(
  row: AllowanceRow,
): Promise<AllowanceSnapshot> {
  const db = await initMirrorDb();
  const spends = recentSpends(db, row.sessionKey, 12);
  const remainingWei =
    row.spentWei >= row.maxGasWei ? 0n : row.maxGasWei - row.spentWei;
  return {
    sessionKey: row.sessionKey,
    master: row.master,
    scope: row.scope,
    entityNamespace: row.entityNamespace,
    maxWrites: row.maxWrites,
    writeCount: row.writeCount,
    maxGasWei: row.maxGasWei.toString(),
    spentWei: row.spentWei.toString(),
    remainingWei: remainingWei.toString(),
    refillThresholdWei: row.refillThresholdWei.toString(),
    estimatedDailyCostWei: row.estimatedDailyCostWei.toString(),
    runwayDays: computeRunwayDays(remainingWei, row.estimatedDailyCostWei),
    validAfter: row.validAfter,
    validBefore: row.validBefore,
    state: row.state,
    createdAtMs: row.createdAtMs,
    lastSpendAtMs: row.lastSpendAtMs,
    refilledFrom: row.refilledFrom,
    recentSpends: spends.map((s) => ({
      atMs: s.atMs,
      gasWei: s.gasWei.toString(),
      txHash: s.txHash,
    })),
  };
}

// Silence unused-import warning while still exporting the day constant for tests
void SECONDS_PER_DAY;

// ---------------------------------------------------------------------------
// POST /api/allowance/create
// ---------------------------------------------------------------------------

export async function handleCreateAllowance(req: Request): Promise<Response> {
  if (req.method !== "POST") return errorJson(405, "method not allowed");
  const body = (await readJsonBody(req)) as CreateAllowanceBody | null;
  if (!body) return errorJson(400, "invalid JSON body");
  if (!isHex(body.signature)) return errorJson(400, "signature required");
  if (!isHex(body.signer)) return errorJson(400, "signer required");
  const auth = parseAuthWire(body.auth);
  if (!auth) return errorJson(400, "invalid SessionAuthorizationV2 fields");

  const db = await initMirrorDb();
  try {
    const row = await createAllowance(db, auth, body.signature, body.signer);
    const snapshot = await buildSnapshot(row);
    return json({ ok: true, sessionKey: row.sessionKey, snapshot });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("signature did not verify")) {
      return errorJson(401, msg);
    }
    return errorJson(400, msg);
  }
}

// ---------------------------------------------------------------------------
// GET /api/allowance?sessionKey=0x… | ?master=0x…
// ---------------------------------------------------------------------------

export async function handleGetAllowance(req: Request): Promise<Response> {
  if (req.method !== "GET") return errorJson(405, "method not allowed");
  const url = new URL(req.url);
  const sessionKey = url.searchParams.get("sessionKey") as Hex | null;
  const master = url.searchParams.get("master") as Hex | null;
  if (!sessionKey && !master) {
    return errorJson(400, "sessionKey or master query param required");
  }
  const db = await initMirrorDb();
  if (sessionKey) {
    if (!isHex(sessionKey)) return errorJson(400, "invalid sessionKey");
    const row = getAllowanceBySessionKey(db, sessionKey);
    if (!row) return errorJson(404, "no allowance for that sessionKey");
    return json(await buildSnapshot(row));
  }
  // master path — return the freshest active (or most recent) allowance for
  // this master, plus a list for visibility.
  if (!isHex(master!)) return errorJson(400, "invalid master");
  const rows = getAllowancesByMaster(db, master!);
  if (rows.length === 0) {
    return errorJson(404, "no allowances for that master");
  }
  const active = rows.find((r) => r.state === "active") ?? rows[0]!;
  const snapshot = await buildSnapshot(active);
  return json({
    active: snapshot,
    all: rows.map((r) => ({
      sessionKey: r.sessionKey,
      state: r.state,
      createdAtMs: r.createdAtMs,
      validBefore: r.validBefore,
      refilledFrom: r.refilledFrom,
    })),
  });
}

// ---------------------------------------------------------------------------
// POST /api/allowance/refill
// ---------------------------------------------------------------------------

export async function handleRefillAllowance(req: Request): Promise<Response> {
  if (req.method !== "POST") return errorJson(405, "method not allowed");
  const body = (await readJsonBody(req)) as RefillAllowanceBody | null;
  if (!body) return errorJson(400, "invalid JSON body");
  if (!isHex(body.prevSessionKey)) return errorJson(400, "prevSessionKey required");
  if (!isHex(body.newSignature)) return errorJson(400, "newSignature required");
  if (!isHex(body.newSigner)) return errorJson(400, "newSigner required");
  const newAuth = parseAuthWire(body.newAuth);
  if (!newAuth) return errorJson(400, "invalid newAuth fields");

  const db = await initMirrorDb();
  const prev = getAllowanceBySessionKey(db, body.prevSessionKey);
  if (!prev) return errorJson(404, "previous allowance not found");

  // Master continuity: only the master who signed `prev` may refill it.
  if (prev.master.toLowerCase() !== newAuth.user.toLowerCase()) {
    return errorJson(
      403,
      "refill master mismatch: newAuth.user must equal prev.master",
    );
  }

  try {
    const row = await createAllowance(db, newAuth, body.newSignature, body.newSigner, {
      refilledFrom: prev.sessionKey,
    });
    // Mark prev as expired AFTER the new row inserts successfully. We do this
    // even when createAllowance returned an existing row (idempotency) — the
    // prev row should still be considered superseded.
    markExpired(db, prev.sessionKey);
    const snapshot = await buildSnapshot(row);
    return json({ ok: true, sessionKey: row.sessionKey, snapshot });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("signature did not verify")) {
      return errorJson(401, msg);
    }
    return errorJson(400, msg);
  }
}

// ---------------------------------------------------------------------------
// POST /api/allowance/spend
// ---------------------------------------------------------------------------

export async function handleRecordSpend(req: Request): Promise<Response> {
  if (req.method !== "POST") return errorJson(405, "method not allowed");
  const body = (await readJsonBody(req)) as RecordSpendBody | null;
  if (!body) return errorJson(400, "invalid JSON body");
  if (!isHex(body.sessionKey)) return errorJson(400, "sessionKey required");
  if (!isDecimalString(body.gasWei)) {
    return errorJson(400, "gasWei must be a decimal string");
  }
  const txHash =
    body.txHash === undefined || body.txHash === null
      ? null
      : isHex(body.txHash)
        ? body.txHash
        : null;

  const db = await initMirrorDb();
  const ok = recordSpend(db, body.sessionKey, txHash, BigInt(body.gasWei));
  const row = getAllowanceBySessionKey(db, body.sessionKey);
  if (!row) return errorJson(404, "allowance not found");
  if (!ok) {
    // 402 Payment Required — the relayer should refuse the underlying write
    // and surface the snapshot so the dashboard can prompt the master to refill.
    return new Response(
      JSON.stringify({
        ok: false,
        error: "allowance exceeded or inactive",
        snapshot: await buildSnapshot(row),
      }),
      {
        status: 402,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  }
  return json({ ok: true, snapshot: await buildSnapshot(row) });
}
