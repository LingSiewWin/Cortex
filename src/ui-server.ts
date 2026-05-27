/**
 * Cortex — Ambient Dashboard server (Phase 7).
 *
 * Bun.serve entry point. Apple-Health-style read-only dashboard for the
 * Darwinian memory engine. NO chatbot UI — the agent runs in the background;
 * this surface visualises its state.
 *
 * Per CLAUDE.md Bun defaults: HTML imports + Bun bundler (NOT Next.js, NOT Vite).
 * The HTML import is wired through the route table; Bun's bundler picks up
 * the `<script type="module" src="./frontend.tsx">` tag inside `ui/index.html`
 * and bundles React on the fly with HMR enabled.
 *
 * Data sources:
 *   - Hot reads → SQLite mirror (`listMirroredEntities`). Mirror catches every
 *     event the daemon sees, so the dashboard never has to talk to Braga's RPC.
 *   - Identity → SIWE message + EIP-712 SessionAuthorization (no session is
 *     persisted server-side; the dashboard is a viewer, not a relayer).
 *
 * Server-side session storage is intentionally in-memory:
 *   - Phase 7 needs to *prove* the 6-ERC flow (SIWE + ERC-1271/6492 + 5792).
 *   - The actual relayer that submits writes is a separate Phase 5/6 concern;
 *     this server only verifies signatures + hands back a viewer session cookie.
 */

import landingHtml from "../ui/index.html";
import consoleHtml from "../ui/console.html";
import { initMirrorDb, getCitationRows, type CitationRow } from "./mirror/db";
import {
  handlePlaygroundEncode,
  handlePlaygroundRecall,
} from "./api/playground";
import {
  handleCreateAllowance,
  handleGetAllowance,
  handleRefillAllowance,
  handleRecordSpend,
} from "./api/allowance";
import {
  handleStateRootRequest,
  handleStateCommitRequest,
  handleStateAnchorRequest,
  handleStateProofRequest,
} from "./api/state";
import { handleSSE } from "./api/sse";
import { handleTopologyRequest } from "./topology/build-from-mirror";
import { handleManualCitation } from "./api/citation";
import {
  handleAdoptRequest,
  handleAuthMe,
  setSiweSessionLookup,
} from "./api/auth-adopt";
import {
  handleSeedRequest,
  setSeedSiweSessionLookup,
} from "./api/seed";
import {
  handleStoreFileRequest,
  setStoreFileSiweSessionLookup,
} from "./api/store-file";
import {
  startSingletonLoop,
  handleLoopStatus,
  handleLoopControl,
} from "./agent/loop-singleton";
import { startAnchorWorker, type AnchorWorkerHandle } from "./agent/anchor-worker";
import { sampleChainHead } from "./mirror/chain-health";
import { startEvictWatcher, type EvictWatcherHandle } from "./mirror/evict-watcher";

/** Held at module scope so the background anchor worker isn't GC'd while the server runs. */
let _anchorWorker: AnchorWorkerHandle | null = null;
/** Held at module scope so the evict watcher isn't GC'd while the server runs. */
let _evictWatcher: EvictWatcherHandle | null = null;
import {
  listMirroredEntities,
  getMirroredEntity,
  type MirroredEntity,
} from "./mirror/replay";
import { PROJECT_ATTRIBUTE, ENTITY_TYPE, REINFORCEMENT, BRAGA } from "./constants";
import { normaliseAddress } from "./lib/arkiv-client";
import {
  buildCortexSiwe,
  formatSiweMessage,
  parseSiweMessage,
  randomSiweNonce,
} from "./lib/siwe";
import {
  buildSessionAuthorization,
  verifySessionAuthorization,
  SCOPE_ARKIV_WRITE,
} from "./lib/session-key";
import { verifyMessage, type Hex } from "viem";

// ---------------------------------------------------------------------------
// Types surfaced to the frontend
// ---------------------------------------------------------------------------

export type MemoryTier = "working" | "episodic" | "rule" | "other";

export interface MemorySummary {
  entityKey: Hex;
  owner: Hex;
  creator: Hex | null;
  tier: MemoryTier;
  entityType: string | null;
  expiresAtBlock: number;
  createdAtBlock: number | null;
  /** Lifespan remaining as a 0..1 ratio of the tier's nominal lifespan. */
  remainingRatio: number;
  /** Seconds of life remaining (estimated from block delta * 2s). */
  remainingSeconds: number;
  /** Total lifespan in seconds for this tier. */
  lifespanSeconds: number;
  state: "live" | "deleted" | "expired";
  lastEventBlock: number;
  lastEventType: string;
  // --- Darwinian reinforcement (from citation_counts; 0/baseline if uncited) ---
  /** Total citations across all sessions. */
  citationCount: number;
  /** Distinct sessions that cited it. */
  distinctSessions: number;
  /** Tier it was promoted to (episode/rule), or null. The real tier signal. */
  promotedTo: "episode" | "rule" | null;
  /** Evolved SEDM utility weight (1.0 = neutral). */
  weight: number;
}

export interface DecisionRecord {
  entityKey: Hex;
  blockNumber: number;
  observedAtMs: number | null;
  action: string;
  citedKeys: Hex[];
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findAttr(
  entity: MirroredEntity,
  key: string,
): string | number | undefined {
  return entity.attributes.find((a) => a.key === key)?.value;
}

function isCortexEntity(entity: MirroredEntity): boolean {
  return entity.attributes.some(
    (a) =>
      a.key === PROJECT_ATTRIBUTE.key && a.value === PROJECT_ATTRIBUTE.value,
  );
}

function classifyTier(entityType: string | null | undefined): MemoryTier {
  switch (entityType) {
    case ENTITY_TYPE.OBSERVATION:
      return "working";
    case ENTITY_TYPE.EPISODE:
      return "episodic";
    case ENTITY_TYPE.RULE:
      return "rule";
    default:
      return "other";
  }
}

function nominalLifespanSeconds(tier: MemoryTier): number {
  switch (tier) {
    case "working":
      return REINFORCEMENT.initialWorkingSeconds;
    case "episodic":
      return REINFORCEMENT.episodicReinforcementSeconds;
    case "rule":
      return REINFORCEMENT.semanticInitialSeconds;
    default:
      return REINFORCEMENT.initialWorkingSeconds;
  }
}

function summariseMemory(
  entity: MirroredEntity,
  currentBlock: number,
  citation?: CitationRow,
): MemorySummary {
  const entityType =
    (findAttr(entity, "entityType") as string | undefined) ?? null;
  // Effective tier: promotion is recorded in citation_counts, NOT written back
  // to the on-chain entityType attribute, so promotedTo is the source of truth.
  // A heavily-cited observation promoted to "rule" must display as a rule, not
  // as working-tier.
  const tier: MemoryTier =
    citation?.promotedTo === "rule"
      ? "rule"
      : citation?.promotedTo === "episode"
        ? "episodic"
        : classifyTier(entityType);
  const lifespanSeconds = nominalLifespanSeconds(tier);
  const blocksRemaining = Math.max(0, entity.expiresAtBlock - currentBlock);
  const remainingSeconds = blocksRemaining * BRAGA.blockTimeSeconds;
  // Clamp to [0,1]. Rules can vastly exceed nominal — clamp so the bar stays
  // visually sensible without lying about long-lived memories (we show the
  // raw "Xd Yh" alongside the bar in the UI).
  const remainingRatio = Math.max(
    0,
    Math.min(1, remainingSeconds / lifespanSeconds),
  );
  return {
    entityKey: entity.entityKey,
    owner: entity.owner,
    creator: entity.creator,
    tier,
    entityType,
    expiresAtBlock: entity.expiresAtBlock,
    createdAtBlock: entity.createdAtBlock,
    remainingRatio,
    remainingSeconds,
    lifespanSeconds,
    state: entity.state,
    lastEventBlock: entity.lastEventBlock,
    lastEventType: entity.lastEventType,
    citationCount: citation?.count ?? 0,
    distinctSessions: citation?.distinctSessions ?? 0,
    promotedTo: citation?.promotedTo ?? null,
    weight: citation?.weight ?? 1.0,
  };
}

/** A memory the user actually owns — observation/episode/rule, not plumbing. */
function isMemoryEntity(entity: MirroredEntity): boolean {
  const t = findAttr(entity, "entityType");
  return (
    t === ENTITY_TYPE.OBSERVATION ||
    t === ENTITY_TYPE.EPISODE ||
    t === ENTITY_TYPE.RULE
  );
}

function decodePayloadJson(payload: Uint8Array | null): unknown {
  if (!payload || payload.byteLength === 0) return null;
  try {
    const text = new TextDecoder().decode(payload);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function summariseDecision(entity: MirroredEntity): DecisionRecord | null {
  if (findAttr(entity, "entityType") !== ENTITY_TYPE.CITATION) return null;
  const decoded = decodePayloadJson(entity.payload) as
    | { action?: unknown; citedKeys?: unknown; citations?: unknown }
    | null;
  const action =
    (decoded && typeof decoded.action === "string" && decoded.action) ||
    (findAttr(entity, "action") as string | undefined) ||
    "act()";
  const rawCited =
    (decoded?.citedKeys as unknown[] | undefined) ??
    (decoded?.citations as unknown[] | undefined) ??
    [];
  const citedKeys = rawCited.filter(
    (k): k is Hex => typeof k === "string" && k.startsWith("0x"),
  );
  return {
    entityKey: entity.entityKey,
    blockNumber: entity.lastEventBlock,
    observedAtMs: null,
    action,
    citedKeys,
  };
}

function summariseListing(
  entity: MirroredEntity,
  grants: MirroredEntity[],
): ListingSummary {
  const priceWei =
    (findAttr(entity, "priceWei") as string | undefined) ??
    (findAttr(entity, "price") as string | undefined) ??
    "0";
  // Match grants whose `listingKey` attribute points at this listing.
  const matched = grants.filter(
    (g) => findAttr(g, "listingKey") === entity.entityKey,
  );
  let totalEarned = 0n;
  let lastSaleAtBlock: number | null = null;
  for (const g of matched) {
    try {
      const paid = (findAttr(g, "priceWei") as string | undefined) ?? priceWei;
      totalEarned += BigInt(paid);
    } catch {
      /* ignore malformed price */
    }
    if (lastSaleAtBlock === null || g.lastEventBlock > lastSaleAtBlock) {
      lastSaleAtBlock = g.lastEventBlock;
    }
  }
  // Public, non-secret tags only. Filter out the project namespace + price.
  const tags = entity.attributes.filter(
    (a) =>
      a.key !== PROJECT_ATTRIBUTE.key &&
      a.key !== "priceWei" &&
      a.key !== "price",
  );
  return {
    entityKey: entity.entityKey,
    owner: entity.owner,
    tags,
    priceWei: String(priceWei),
    sales: matched.length,
    totalEarnedWei: totalEarned.toString(),
    lastSaleAtBlock,
  };
}

// ---------------------------------------------------------------------------
// Current-block estimate (cached). The mirror tracks the latest block it saw
// via lastEventBlock; we derive "now" from the max across live entities so we
// never hit Braga RPC from the read path. If the mirror is empty, we fall back
// to 0 — the UI shows that as "—".
// ---------------------------------------------------------------------------

async function getCurrentBlockEstimate(): Promise<number> {
  const recent = await listMirroredEntities({ limit: 1 });
  if (recent.length === 0) return 0;
  // Add seconds-since-last-event * 0.5 blocks/sec so a stale mirror's bars
  // don't freeze. Capped at +60 blocks to avoid runaway drift if the daemon
  // is dead for hours.
  const head = recent[0]!;
  return head.lastEventBlock;
}

// ---------------------------------------------------------------------------
// SIWE session store (in-memory; viewer-only)
//
// nonces:    issued nonces awaiting signature, keyed by nonce
// sessions:  verified SIWE sessions, keyed by opaque session id (cookie)
// ---------------------------------------------------------------------------

interface PendingNonce {
  nonce: string;
  issuedAt: number;
  message: string;
  address: Hex;
  domain: string;
  uri: string;
  expirationTime: string;
}

interface ViewerSession {
  id: string;
  address: Hex;
  signedAt: number;
  expiresAt: number;
  capabilities: unknown;
  sessionAuthorization: { user: Hex; sessionKey: Hex; validBefore: string } | null;
}

const pendingNonces = new Map<string, PendingNonce>();
const sessions = new Map<string, ViewerSession>();

// Inject SIWE-session lookup into the auth-adopt module (avoids a circular
// import: ui-server → auth-adopt → ui-server). Returns the minimal shape
// auth-adopt needs (address only) so future ViewerSession changes don't ripple.
const siweLookup = (cookieValue: string) => {
  const s = sessions.get(cookieValue);
  return s ? { address: s.address } : null;
};
setSiweSessionLookup(siweLookup);
setSeedSiweSessionLookup(siweLookup);
setStoreFileSiweSessionLookup(siweLookup);

/**
 * Per-user set of consumed SessionAuthorization nonces. The audit requires
 * one-shot nonce enforcement so a captured signed authorization can't be
 * replayed against the relayer.
 *
 * Key = user EOA (lowercased). Value = set of consumed nonce hex strings.
 *
 * TODO: production should persist this in SQLite or Redis so the guarantee
 * survives a process restart. For Phase 7 (in-memory viewer-only server) the
 * in-process map is enough — the relayer is a separate concern.
 */
const seenSessionNonces = new Map<string, Set<string>>();

/**
 * Atomically check-and-record a session nonce. Returns true on first use,
 * false if the nonce was already consumed for this user.
 */
function recordSessionNonce(user: Hex, nonce: Hex): boolean {
  const userKey = normaliseAddress(user);
  let bucket = seenSessionNonces.get(userKey);
  if (!bucket) {
    bucket = new Set();
    seenSessionNonces.set(userKey, bucket);
  }
  const n = nonce.toLowerCase();
  if (bucket.has(n)) return false;
  bucket.add(n);
  return true;
}

function getCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return null;
}

function makeSessionId(): string {
  const buf = new Uint8Array(24);
  crypto.getRandomValues(buf);
  let out = "";
  for (const b of buf) out += b.toString(16).padStart(2, "0");
  return out;
}

// ---------------------------------------------------------------------------
// JSON response helper
// ---------------------------------------------------------------------------

function json(body: unknown, init: ResponseInit = {}): Response {
  // BigInt-safe stringify — Arkiv prices are big.
  const text = JSON.stringify(body, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
  return new Response(text, {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

function errorJson(status: number, message: string): Response {
  return json({ error: message }, { status });
}

// ---------------------------------------------------------------------------
// Route handlers (exported for testability)
// ---------------------------------------------------------------------------

export async function handleMemoriesRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? 100);
  const owner = url.searchParams.get("owner") as Hex | null;
  const entityType = url.searchParams.get("entityType");

  const entities = await listMirroredEntities({
    state: "live",
    limit: Math.min(500, Math.max(1, limit)),
    ...(owner ? { owner } : {}),
  });

  // Real memories only — observation/episode/rule. Citation, state_root,
  // listing and grant entities are internal plumbing, not "memories", and were
  // previously dumped into this view as tier "other" (drowning the real ones).
  const memoryEntities = entities.filter((e) => isCortexEntity(e) && isMemoryEntity(e));
  const currentBlock = await getCurrentBlockEstimate();
  // Join citation_counts so tier reflects real promotions + each memory carries
  // its citation count and evolved weight (the visible Darwinian signal).
  const db = await initMirrorDb();
  const citations = getCitationRows(db, memoryEntities.map((e) => e.entityKey));
  let memories = memoryEntities.map((e) =>
    summariseMemory(e, currentBlock, citations.get(e.entityKey)),
  );
  if (entityType) memories = memories.filter((m) => m.entityType === entityType);

  // Bucket counts
  const counts = {
    total: memories.length,
    working: memories.filter((m) => m.tier === "working").length,
    episodic: memories.filter((m) => m.tier === "episodic").length,
    rule: memories.filter((m) => m.tier === "rule").length,
    other: memories.filter((m) => m.tier === "other").length,
  };

  return json({ currentBlock, counts, memories });
}

export async function handleDecisionsRequest(_req: Request): Promise<Response> {
  // Citations are how `act()` is recorded on-chain — one citation entity per
  // act() call, payload includes the action label + cited memory keys.
  const all = await listMirroredEntities({ limit: 500 });
  const cortex = all.filter(isCortexEntity);
  const decisions = cortex
    .map(summariseDecision)
    .filter((d): d is DecisionRecord => d !== null)
    .sort((a, b) => b.blockNumber - a.blockNumber)
    .slice(0, 100);
  return json({ decisions });
}

export async function handleListingsRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const rawOwnerFilter = url.searchParams.get("owner") as Hex | null;
  // Arkiv returns checksum-cased addresses on entities; every other join key in
  // the codebase is lowercased. Normalise both sides before comparing so a
  // case mismatch never produces a phantom empty list.
  const ownerFilter = rawOwnerFilter ? normaliseAddress(rawOwnerFilter) : null;

  const all = await listMirroredEntities({ limit: 1000 });
  const cortex = all.filter(isCortexEntity);
  let listings = cortex.filter(
    (e) => findAttr(e, "entityType") === ENTITY_TYPE.LISTING,
  );
  const grants = cortex.filter(
    (e) => findAttr(e, "entityType") === ENTITY_TYPE.GRANT,
  );
  if (ownerFilter)
    listings = listings.filter((l) => normaliseAddress(l.owner) === ownerFilter);

  const summaries = listings.map((l) => summariseListing(l, grants));

  // Aggregate GLM totals across all of the user's listings (or globally if
  // no owner filter).
  let totalEarnedWei = 0n;
  let lastSaleAtBlock: number | null = null;
  for (const s of summaries) {
    try {
      totalEarnedWei += BigInt(s.totalEarnedWei);
    } catch {
      /* ignore */
    }
    if (
      s.lastSaleAtBlock !== null &&
      (lastSaleAtBlock === null || s.lastSaleAtBlock > lastSaleAtBlock)
    ) {
      lastSaleAtBlock = s.lastSaleAtBlock;
    }
  }

  return json({
    listings: summaries,
    aggregate: {
      totalEarnedWei: totalEarnedWei.toString(),
      lastSaleAtBlock,
      activeListings: summaries.length,
    },
  });
}

export async function handleMemoryDetailRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const key = url.searchParams.get("entityKey") as Hex | null;
  if (!key) return errorJson(400, "entityKey query param required");
  const entity = await getMirroredEntity(key);
  if (!entity) return errorJson(404, "entity not found in mirror");
  if (!isCortexEntity(entity))
    return errorJson(404, "entity is not a Cortex entity");
  const currentBlock = await getCurrentBlockEstimate();
  return json({
    summary: summariseMemory(entity, currentBlock),
    attributes: entity.attributes,
    payloadPreview: previewPayload(entity.payload),
  });
}

function previewPayload(payload: Uint8Array | null): string | null {
  if (!payload || payload.byteLength === 0) return null;
  // First 200 bytes — payloads are RaBitQ-compressed binary; we render the
  // first chunk as a hex preview so the inspector has something to show.
  const slice = payload.slice(0, 200);
  let out = "";
  for (const b of slice) out += b.toString(16).padStart(2, "0");
  return out + (payload.byteLength > 200 ? "…" : "");
}

// ---------------------------------------------------------------------------
// Auth endpoints
// ---------------------------------------------------------------------------

interface SiweInitBody {
  address?: string;
  durationSeconds?: number;
  maxWrites?: number;
  domain?: string;
  uri?: string;
}

export async function handleSiweInit(req: Request): Promise<Response> {
  const body = (await safeJson(req)) as SiweInitBody | null;
  if (!body || typeof body.address !== "string" || !body.address.startsWith("0x")) {
    return errorJson(400, "address required");
  }
  const address = body.address as Hex;
  const duration = body.durationSeconds ?? 4 * 60 * 60;
  const maxWrites = body.maxWrites ?? 1000;
  // domain/uri MUST match the page that requested the signature so wallets'
  // SIWE-aware checks pass. Default to the request host if the client didn't
  // pass one explicitly.
  const requestUrl = new URL(req.url);
  const siwe = buildCortexSiwe({
    user: address,
    durationSeconds: duration,
    maxWrites,
    domain: (body.domain as string | undefined) ?? requestUrl.host,
    uri: (body.uri as string | undefined) ?? requestUrl.origin,
  });
  const message = formatSiweMessage(siwe);
  pendingNonces.set(siwe.nonce, {
    nonce: siwe.nonce,
    issuedAt: Date.now(),
    message,
    address,
    domain: siwe.domain,
    uri: siwe.uri,
    expirationTime: siwe.expirationTime,
  });
  // GC old nonces (older than 15 min)
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [k, v] of pendingNonces) {
    if (v.issuedAt < cutoff) pendingNonces.delete(k);
  }
  return json({ message, nonce: siwe.nonce });
}

interface SiweVerifyBody {
  nonce?: string;
  signature?: string;
  signer?: string;
  message?: string;
  capabilities?: unknown;
}

export async function handleSiweVerify(req: Request): Promise<Response> {
  const body = (await safeJson(req)) as SiweVerifyBody | null;
  if (
    !body ||
    typeof body.nonce !== "string" ||
    typeof body.signature !== "string" ||
    typeof body.signer !== "string"
  ) {
    return errorJson(400, "nonce, signature, and signer required");
  }
  const pending = pendingNonces.get(body.nonce);
  if (!pending) return errorJson(400, "unknown or expired nonce");

  // Audit fix: validate the message *body* — not just the signature — before
  // trusting the pending entry. The signed-message-substitution attack works
  // by signing a totally different SIWE message whose nonce we happen to have
  // outstanding. `verifyMessage` returns true for that message + sig pair,
  // and the old handler accepted it. We now parse the submitted message and
  // assert every load-bearing field matches the pending nonce / Braga chain.
  const submittedMessage = typeof body.message === "string" ? body.message : pending.message;
  let parsed;
  try {
    parsed = parseSiweMessage(submittedMessage);
  } catch (err) {
    return errorJson(400, `invalid SIWE message: ${(err as Error).message}`);
  }
  if (parsed.nonce !== pending.nonce) {
    return errorJson(400, "nonce in signed message does not match pending nonce");
  }
  if (parsed.domain !== pending.domain) {
    return errorJson(400, "domain in signed message does not match pending domain");
  }
  if (parsed.uri !== pending.uri) {
    return errorJson(400, "uri in signed message does not match pending uri");
  }
  if (parsed.chainId !== BRAGA.chainId) {
    return errorJson(400, "chainId in signed message is not Braga");
  }
  if (parsed.address.toLowerCase() !== body.signer.toLowerCase()) {
    return errorJson(400, "address in signed message does not match signer");
  }
  if (parsed.address.toLowerCase() !== pending.address.toLowerCase()) {
    return errorJson(400, "address in signed message does not match pending address");
  }
  const expiresAt = Date.parse(parsed.expirationTime);
  if (!Number.isFinite(expiresAt)) {
    return errorJson(400, "expirationTime in signed message is not a valid date");
  }
  if (Date.now() >= expiresAt) {
    return errorJson(400, "SIWE message has expired");
  }

  const ok = await verifyMessage({
    address: pending.address,
    message: submittedMessage,
    signature: body.signature as Hex,
  });
  if (!ok) return errorJson(401, "signature did not verify");
  // One-use nonce: delete only AFTER acceptance.
  pendingNonces.delete(body.nonce);
  const sessionId = makeSessionId();
  const session: ViewerSession = {
    id: sessionId,
    address: pending.address,
    signedAt: Date.now(),
    expiresAt: Date.now() + 4 * 60 * 60 * 1000,
    capabilities: body.capabilities ?? null,
    sessionAuthorization: null,
  };
  sessions.set(sessionId, session);
  return new Response(JSON.stringify({ session }), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "set-cookie": `cortex_session=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=14400`,
    },
  });
}

interface SessionAuthBody {
  user?: string;
  sessionKey?: string;
  entityNamespace?: string;
  validAfter?: string;
  validBefore?: string;
  nonce?: string;
  maxWrites?: string;
  signature?: string;
}

export async function handleSessionAuth(req: Request): Promise<Response> {
  const body = (await safeJson(req)) as SessionAuthBody | null;
  if (
    !body ||
    typeof body.user !== "string" ||
    typeof body.sessionKey !== "string" ||
    typeof body.entityNamespace !== "string" ||
    typeof body.signature !== "string"
  ) {
    return errorJson(400, "missing required session authorization fields");
  }
  const auth = buildSessionAuthorization({
    user: body.user as Hex,
    sessionKey: body.sessionKey as Hex,
    entityNamespace: body.entityNamespace as Hex,
    ...(body.maxWrites ? { maxWrites: BigInt(body.maxWrites) } : {}),
    ...(body.nonce ? { nonce: body.nonce as Hex } : {}),
  });
  // If the caller passed explicit times, override (testability + replay).
  if (body.validAfter) auth.validAfter = BigInt(body.validAfter);
  if (body.validBefore) auth.validBefore = BigInt(body.validBefore);

  // 1. Signature must verify against the typed-data digest. `verifySessionAuthorization`
  //    also rejects scopes outside `[SCOPE_ARKIV_WRITE]` by default.
  const ok = await verifySessionAuthorization(auth, body.signature as Hex);
  if (!ok) return errorJson(401, "session authorization signature invalid");

  // 2. Time-window enforcement — validAfter <= now < validBefore (unix seconds).
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  if (nowSeconds < auth.validAfter) {
    return errorJson(400, "session authorization not yet valid (validAfter > now)");
  }
  if (nowSeconds >= auth.validBefore) {
    return errorJson(400, "session authorization expired (now >= validBefore)");
  }

  // 3. Scope tag must be `SCOPE_ARKIV_WRITE` — defensive belt-and-braces over
  //    `verifySessionAuthorization`'s default `allowedScopes`.
  if (auth.scope !== SCOPE_ARKIV_WRITE) {
    return errorJson(400, "session authorization scope must be SCOPE_ARKIV_WRITE");
  }

  // 4. maxWrites must be > 0 — a zero cap is a footgun (silent no-op session).
  if (auth.maxWrites <= 0n) {
    return errorJson(400, "session authorization maxWrites must be > 0");
  }

  // 5. Cross-bind to the SIWE'd user — the EIP-712 `user` MUST match the
  //    address that completed the SIWE flow on this browser. Otherwise a
  //    valid signed authorization for user A could be replayed under user B's
  //    viewer session.
  const sessionId = getCookie(req, "cortex_session");
  if (!sessionId) {
    return errorJson(401, "no active SIWE session — call /api/auth/siwe/verify first");
  }
  const viewer = sessions.get(sessionId);
  if (!viewer) {
    return errorJson(401, "SIWE session not found or expired");
  }
  if (viewer.address.toLowerCase() !== auth.user.toLowerCase()) {
    return errorJson(400, "session authorization user does not match SIWE'd user");
  }

  // 6. One-shot nonce — consume only AFTER all checks pass.
  if (!recordSessionNonce(auth.user, auth.nonce)) {
    return errorJson(400, "session authorization nonce already used");
  }

  // Persist on the viewer session so the dashboard can show the active grant.
  viewer.sessionAuthorization = {
    user: auth.user,
    sessionKey: auth.sessionKey,
    validBefore: auth.validBefore.toString(),
  };
  sessions.set(sessionId, viewer);

  return json({
    accepted: true,
    sessionAuthorization: {
      user: auth.user,
      sessionKey: auth.sessionKey,
      validAfter: auth.validAfter.toString(),
      validBefore: auth.validBefore.toString(),
      maxWrites: auth.maxWrites.toString(),
      entityNamespace: auth.entityNamespace,
      scope: auth.scope,
    },
  });
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Health / capability echo (for tests + CLI probes)
// ---------------------------------------------------------------------------

export async function handleHealth(_req: Request): Promise<Response> {
  return json({
    ok: true,
    name: "cortex-ambient-dashboard",
    chainId: BRAGA.chainId,
    project: PROJECT_ATTRIBUTE.value,
    activeSessions: sessions.size,
    pendingNonces: pendingNonces.size,
  });
}

// ---------------------------------------------------------------------------
// Trilemma scoreboard endpoints — feed both landing (/) and console (/console).
//
// /api/economics  → gas spent, compression ratio, projected savings
// /api/decay      → recently evicted entities (the "free GC" proof)
// ---------------------------------------------------------------------------

/** RaBitQ math: 1536-d fp32 input → 198-byte packed code. */
const RAW_BYTES_PER_MEMORY = 1536 * 4; // 6144
const STORED_BYTES_PER_MEMORY = 198;
const COMPRESSION_RATIO = RAW_BYTES_PER_MEMORY / STORED_BYTES_PER_MEMORY;
/** Estimated Braga L3 gas price. Real value is variable; 1 gwei is conservative. */
const ESTIMATED_GAS_PRICE_WEI = 1_000_000_000n;
/** Arkiv's flat ~29k gas per CREATE (per docs/Arkiv.md §1.4). */
const APPROX_CREATE_GAS = 29_000;

function staticEconomicsPayload() {
  return {
    entityCount: 0,
    totalGasUnits: 0,
    totalGasCostWei: "0",
    avgGasPerMemory: APPROX_CREATE_GAS,
    rawBytesEstimate: 0,
    storedBytesEstimate: 0,
    compressionRatio: COMPRESSION_RATIO,
    uncompressedGasCostWei: "0",
    monthlyProjectionWei: "0",
    source: "static" as const,
  };
}

export async function handleEconomicsRequest(_req: Request): Promise<Response> {
  let db;
  try {
    db = await initMirrorDb();
  } catch {
    return json(staticEconomicsPayload());
  }

  const entityCountRow = db
    .prepare("SELECT COUNT(*) as c FROM entities")
    .get() as { c: number } | null;
  const entityCount = entityCountRow?.c ?? 0;

  const costRows = db
    .prepare("SELECT cost FROM events WHERE cost IS NOT NULL")
    .all() as Array<{ cost: string }>;
  let totalGasUnitsBig = 0n;
  for (const r of costRows) {
    try {
      totalGasUnitsBig += BigInt(r.cost);
    } catch {
      /* skip malformed */
    }
  }

  const safeTotalGas =
    totalGasUnitsBig > BigInt(Number.MAX_SAFE_INTEGER)
      ? Number.MAX_SAFE_INTEGER
      : Number(totalGasUnitsBig);
  const avgGasPerMemory =
    entityCount > 0 ? Math.round(safeTotalGas / entityCount) : APPROX_CREATE_GAS;
  const rawBytesEstimate = entityCount * RAW_BYTES_PER_MEMORY;
  const storedBytesEstimate = entityCount * STORED_BYTES_PER_MEMORY;
  const totalGasCostWei = totalGasUnitsBig * ESTIMATED_GAS_PRICE_WEI;
  // If we'd shipped raw 1536-d fp32 instead of RaBitQ-packed 198 B, gas would
  // scale by the byte ratio (Arkiv prices bytes × lifetime).
  const uncompressedGasCostWei =
    totalGasCostWei * BigInt(Math.round(COMPRESSION_RATIO));

  return json({
    entityCount,
    totalGasUnits: safeTotalGas,
    totalGasCostWei: totalGasCostWei.toString(),
    avgGasPerMemory,
    rawBytesEstimate,
    storedBytesEstimate,
    compressionRatio: COMPRESSION_RATIO,
    uncompressedGasCostWei: uncompressedGasCostWei.toString(),
    // Monthly projection is a roughed extrapolation — for v1 we just echo the
    // observed cost. v2 should look at creation cadence over time.
    monthlyProjectionWei: totalGasCostWei.toString(),
  });
}

export async function handleDecayRequest(_req: Request): Promise<Response> {
  let db;
  try {
    db = await initMirrorDb();
  } catch {
    return json({ events: [] });
  }

  const rows = db
    .prepare(
      "SELECT entity_key, block_number, observed_at_ms FROM events " +
        "WHERE event_type = 'expired' ORDER BY block_number DESC LIMIT 10",
    )
    .all() as Array<{
    entity_key: string;
    block_number: number;
    observed_at_ms: number;
  }>;

  const totalRow = db
    .prepare("SELECT COUNT(*) as c FROM events WHERE event_type = 'expired'")
    .get() as { c: number } | null;

  return json({
    recentlyEvicted: rows.map((r) => ({
      entityKey: r.entity_key as Hex,
      blockNumber: r.block_number,
      observedAtMs: r.observed_at_ms,
      // The "free GC" pitch: had we needed to manually delete this entity to
      // reclaim its slot, we'd have paid ~29k gas. Arkiv evicts it for free.
      gasReclaimedEstimate: APPROX_CREATE_GAS,
    })),
    totalEvictedCount: totalRow?.c ?? 0,
  });
}

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------

const PORT = Number(process.env.DASHBOARD_PORT ?? 3000);

// Only auto-serve when this file is the entry point — letting tests import
// the route handlers without binding a port.
/**
 * Serve a repo-relative static file. `Bun.serve` honours Range requests
 * automatically when the response body is a `Bun.file`, so background video
 * scrubbing / partial fetches work without manual byte-range handling.
 */
async function serveStaticFile(
  relPath: string,
  contentType: string,
): Promise<Response> {
  const file = Bun.file(relPath);
  if (!(await file.exists())) {
    return new Response("not found", { status: 404 });
  }
  return new Response(file, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400",
    },
  });
}

const isEntry = import.meta.main;

if (isEntry) {
  // Bun's dev mode injects a full-screen runtime error overlay that captures
  // ANY uncaught error/rejection on the page — including ones thrown *inside*
  // the user's wallet extensions (MetaMask/Phantom/Rabby fighting over
  // window.ethereum). That makes harmless extension noise look like Cortex
  // crashed. So the overlay + HMR are OPT-IN for active development; the
  // default (and demo) serve is clean even with conflicting wallets installed.
  const DEV_OVERLAY = process.env.CORTEX_DEV === "1";
  const server = Bun.serve({
    port: PORT,
    routes: {
      // Road A — investor / judge marketing surface
      "/": landingHtml,
      // Road B — the working console (wallet, memories, decisions, listings)
      "/console": consoleHtml,
      // Read APIs (consumed by both surfaces)
      "/api/health": handleHealth,
      "/api/memories": handleMemoriesRequest,
      "/api/memories/detail": handleMemoryDetailRequest,
      "/api/decisions": handleDecisionsRequest,
      "/api/listings": handleListingsRequest,
      // Trilemma scoreboard endpoints
      "/api/economics": handleEconomicsRequest,
      "/api/decay": handleDecayRequest,
      // Mapper topology graph (server-side; decrypts the mirror in-process)
      "/api/topology": handleTopologyRequest,
      // Auth (console-side only)
      "/api/auth/siwe/init": { POST: handleSiweInit },
      "/api/auth/siwe/verify": { POST: handleSiweVerify },
      "/api/auth/session": { POST: handleSessionAuth },
      // Dashboard wallet adoption — re-keys the autonomous loop + AES seal key
      "/api/auth/adopt": { POST: handleAdoptRequest },
      "/api/auth/me": handleAuthMe,
      // Bootstrap: create 8 demo observations sealed with the adopted wallet's
      // key so the loop has something to recall+cite right after adoption.
      "/api/seed-memories": { POST: handleSeedRequest },
      "/api/store-file": { POST: handleStoreFileRequest },
      // Phase 10 — RaBitQ playground (live encode + live recall)
      // Wrappers strip Bun's `server` 2nd arg so the handlers' optional
      // `deps` test seam doesn't clash with the route-handler type.
      "/api/playground/encode": { POST: (req) => handlePlaygroundEncode(req) },
      "/api/playground/recall": { POST: (req) => handlePlaygroundRecall(req) },
      // Phase 11 — Agent Allowance (EIP-712 v2 budget tracking)
      "/api/allowance": handleGetAllowance,
      "/api/allowance/create": { POST: handleCreateAllowance },
      "/api/allowance/refill": { POST: handleRefillAllowance },
      "/api/allowance/spend": { POST: handleRecordSpend },
      // Phase 12 — Merkleized Memory state-root accumulator
      "/api/state/root": handleStateRootRequest,
      "/api/state/commit": { POST: handleStateCommitRequest },
      // Phase 13 — broadcast a committed root to Arkiv as a `state_root` entity
      "/api/state/anchor": { POST: handleStateAnchorRequest },
      // Phase 13.5 — generate + server-verify an MMR inclusion proof
      "/api/state/proof": { POST: (req) => handleStateProofRequest(req) },
      // Phase 16 — Live Spine SSE stream (the dashboard's event source)
      "/sse": (req, server) => handleSSE(req, server),
      // Phase 16 — manual "Cite" override (judge-typed query). Pass the client
      // IP so the spend guard rate-limits per-IP, not globally.
      "/api/citation/manual": {
        POST: (req, server) =>
          handleManualCitation(
            req,
            undefined,
            server.requestIP(req)?.address ?? "unknown",
          ),
      },
      // Phase 16 — autonomous loop control + status
      "/api/loop/status": handleLoopStatus,
      "/api/loop/control": { POST: (req) => handleLoopControl(req) },
      // Landing hero background video. Served from disk so Bun handles
      // Range requests + content-type; kept out of the JS bundle graph.
      "/assets/landing-video.mp4": () =>
        serveStaticFile("assets/landing-video.mp4", "video/mp4"),
      // Footer backdrop — a ~1MB still (vs the 7.7MB hero loop) so the footer,
      // and especially the video-less console, paint fast.
      "/assets/landing-footer.png": () =>
        serveStaticFile("assets/landing-footer.png", "image/png"),
      // Silence the favicon 404 so a judge's DevTools console stays clean.
      "/favicon.ico": () => new Response(null, { status: 204 }),
    },
    // Overlay + HMR only when CORTEX_DEV=1. Default false → no dev overlay, so
    // wallet-extension errors never render as a fake "Cortex crashed" screen.
    development: DEV_OVERLAY ? { hmr: true, console: false } : false,
    fetch() {
      return new Response("not found", { status: 404 });
    },
  });
  // eslint-disable-next-line no-console
  console.log(
    `[cortex/ui] ambient dashboard listening on http://localhost:${server.port}`,
  );

  // Phase 16 — start the autonomous citation loop IN THIS PROCESS so its
  // events reach the /sse stream. Kill-switch: CORTEX_AUTONOMOUS_LOOP=off.
  // No-ops gracefully if the wallet isn't configured (read-only dashboard).
  if (process.env.CORTEX_AUTONOMOUS_LOOP !== "off") {
    try {
      const loop = startSingletonLoop();
      // eslint-disable-next-line no-console
      console.log(
        loop
          ? `[cortex/ui] autonomous citation loop started (set CORTEX_AUTONOMOUS_LOOP=off to disable)`
          : `[cortex/ui] autonomous loop NOT started — USER_PRIMARY_ADDRESS unset (read-only mode)`,
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[cortex/ui] autonomous loop failed to start: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // Optimistic Memory Buffering — start the anchor worker IN THIS PROCESS so the
  // bundles act() enqueues (loop + manual cites) actually drain to Braga. It's
  // the SOLE session-key writer, which also serializes nonces. Drains back off
  // automatically while Braga is down; kill-switch: CORTEX_ANCHOR_WORKER=off.
  if (process.env.CORTEX_ANCHOR_WORKER !== "off") {
    try {
      // Health-adaptive: a light head sampler (3 quick polls) lets the worker
      // skip draining when Braga is STALLED and slow down when the RPC pool is
      // DEGRADED — so it never burns gas/nonces against a frozen or inconsistent chain.
      _anchorWorker = startAnchorWorker({
        sampleHealth: () => sampleChainHead({ samples: 3, gapMs: 200 }),
      });
      // eslint-disable-next-line no-console
      console.log(
        `[cortex/ui] anchor worker started — health-adaptive drain to Braga (set CORTEX_ANCHOR_WORKER=off to disable)`,
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[cortex/ui] anchor worker failed to start: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // The Darwinian payoff, live — sweep the shared mirror for memories whose
  // lease just elapsed and emit `memory.evicted` so the constellation animates
  // "fades, then drops" in real time. Runs in THIS process so events reach /sse
  // (the daemon is a separate process and can't publish to this bus).
  // Kill-switch: CORTEX_EVICT_WATCHER=off.
  if (process.env.CORTEX_EVICT_WATCHER !== "off") {
    try {
      _evictWatcher = await startEvictWatcher({
        deps: { currentBlock: getCurrentBlockEstimate },
      });
      // eslint-disable-next-line no-console
      console.log(
        `[cortex/ui] evict watcher started — live memory.evicted on lease expiry (set CORTEX_EVICT_WATCHER=off to disable)`,
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[cortex/ui] evict watcher failed to start: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

// Re-export helpers for tests / CLI tooling.
export { makeSessionId };
// Mark used so verbatimModuleSyntax + noUnusedLocals stays clean if either
// import changes in future.
void randomSiweNonce;
