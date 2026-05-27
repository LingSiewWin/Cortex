/**
 * Cortex — batched writes via mutateEntities.
 *
 * Per docs/discussion2.md Founder Mode pitch + README math:
 *   "We batch N memories per Arkiv transaction, paying ~600 gas per memory
 *    instead of ~29,000."
 *
 * The honest win: amortize the ~29k flat tx overhead across many creates.
 * The SDK already does brotli-RLP under the hood — no WASM gymnastics needed
 * for v1 (per docs/CLAUDE.md Phase 0 decisions).
 *
 * Every create stamps PROJECT_ATTRIBUTE via lib/arkiv-client. Forgetting is
 * impossible by construction.
 */

import type { Hex } from "@arkiv-network/sdk";
import type { Attribute } from "@arkiv-network/sdk/types";
import { stampProjectAttribute, getWalletClient, instrumentRpc } from "./arkiv-client";
import { withRetry } from "./errors";
import { publish } from "./events";
import { sealPayload } from "./crypto";
import { requirePayloadKey } from "./payload-key";
import { ENTITY_TYPE, SEALED_CONTENT_TYPE, REINFORCEMENT, WORKSPACE_ATTR } from "../constants";
import {
  encodeDocumentPayload,
  DOCUMENT_SCHEMA_VERSION,
  type DocumentSectionInput,
} from "../compression/document-payload";

/** Map a stamped `entityType` attribute to a Constellation tier (or undefined
 *  for non-memory entities like citation / state_root / listing / grant).
 *  Documents are durable, so they render as a `rule`-tier (cold/blue) node. */
const TIER_BY_ENTITY_TYPE: Record<string, "working" | "episodic" | "rule"> = {
  [ENTITY_TYPE.OBSERVATION]: "working",
  [ENTITY_TYPE.EPISODE]: "episodic",
  [ENTITY_TYPE.RULE]: "rule",
  [ENTITY_TYPE.DOCUMENT]: "rule",
};

/** A single create spec — caller-supplied. PROJECT_ATTRIBUTE is added for you. */
export interface CortexCreate {
  payload: Uint8Array;
  attributes: Attribute[];
  contentType: string;
  /** Lifespan in seconds. Use ExpirationTime helpers; never raw seconds. */
  expiresInSeconds: number;
}

export interface BatchCreateResult {
  txHash: Hex;
  /** Entity keys in the same order as the input array. */
  entityKeys: Hex[];
}

/**
 * Batch many creates into one Arkiv transaction. Returns the txHash and the
 * entity keys in input order.
 *
 * Soft cap recommendation: ~50 creates per call. The op-reth ExEx loop processes
 * the whole batch atomically; very large batches risk gas-limit issues or
 * client-side memory blowup on brotli compression. Tune empirically.
 */
export async function batchCreate(items: CortexCreate[]): Promise<BatchCreateResult> {
  if (items.length === 0) {
    throw new Error("batchCreate called with empty items array");
  }

  const wallet = getWalletClient();
  const creates = items.map((item) => ({
    payload: item.payload,
    attributes: stampProjectAttribute(item.attributes),
    contentType: item.contentType,
    expiresIn: item.expiresInSeconds,
  }));

  const byteSize = items.reduce((acc, i) => acc + i.payload.byteLength, 0);
  const result = await instrumentRpc(
    "mutateEntities",
    () =>
      withRetry(() => wallet.mutateEntities({ creates }), {
        label: `batchCreate(n=${items.length})`,
      }),
    (r) => ({ txHash: r.txHash, byteSize }),
  );

  // Live spine — emit memory.created for each newly-created memory entity
  // (observation/episode/rule). Non-memory writes (citation, state_root,
  // listing, grant) are skipped so the Constellation only gets real dots.
  // expiresAtBlock is 0 here (not known until the tx mines); the dashboard's
  // /api/memories poll backfills the real value within one refresh cycle.
  for (let i = 0; i < items.length; i++) {
    const et = items[i]!.attributes.find((a) => a.key === "entityType")?.value;
    const tier = typeof et === "string" ? TIER_BY_ENTITY_TYPE[et] : undefined;
    const key = result.createdEntities[i];
    if (tier && key) {
      publish({
        type: "memory.created",
        ts: Date.now(),
        entityKey: key,
        tier,
        expiresAtBlock: 0,
      });
    }
  }

  return {
    txHash: result.txHash,
    entityKeys: result.createdEntities,
  };
}

/**
 * Convenience for the single-entity case. Still goes through mutateEntities so
 * we have consistent ownership/relayer plumbing in v2.
 */
export async function singleCreate(item: CortexCreate): Promise<{
  txHash: Hex;
  entityKey: Hex;
}> {
  const { txHash, entityKeys } = await batchCreate([item]);
  const entityKey = entityKeys[0];
  if (!entityKey) {
    throw new Error("singleCreate: mutateEntities returned no entity keys");
  }
  return { txHash, entityKey };
}

// ---------------------------------------------------------------------------
// Sealed memory writes — the encryption-at-rest chokepoint.
//
// Memory entities (observation / episode / rule) are the only payloads recall
// scores, and the only ones we encrypt: the RaBitQ/rule bytes are sealed with
// the wallet-derived key (src/lib/payload-key.ts) and stamped SEALED_CONTENT_TYPE
// so the chain holds ciphertext. recall (src/darwinian/recall.ts) decrypts in RAM
// after reading the local mirror. Non-memory writes (citation, state_root, market
// listing/grant) keep using singleCreate/batchCreate directly and stay plaintext.
//
// The original contentType is intentionally replaced by SEALED_CONTENT_TYPE; the
// `entityType` attribute (stamped by callers) remains the type-of-record.
// ---------------------------------------------------------------------------

/** Create one sealed memory entity. Throws if no wallet key is available. */
export async function createMemory(item: CortexCreate): Promise<{
  txHash: Hex;
  entityKey: Hex;
}> {
  const key = await requirePayloadKey();
  const sealed = await sealPayload(key, item.payload);
  return singleCreate({ ...item, payload: sealed, contentType: SEALED_CONTENT_TYPE });
}

// ---------------------------------------------------------------------------
// Document Tier — opt-in full-text + embedding sealed write.
//
// Unlike observation/episode (which seal only a lossy ~198-byte RaBitQ
// fingerprint), a document seals CBOR{ full text + embeddings } so the note is
// recoverable from the wallet alone. Durable lease by default. Queryable
// attributes carry NO content (only ids/hashes) — title/path/text/frontmatter
// stay inside the sealed payload.
// ---------------------------------------------------------------------------

export interface DocumentCreateInput {
  /** Full UTF-8 note text — preserved losslessly in the sealed payload. */
  text: string;
  /** Whole-note 1536-d embedding (full precision). */
  embedding: Float32Array;
  /** Optional passage-level sections for finer recall (one entity either way). */
  sections?: DocumentSectionInput[];
  title?: string;
  vaultPath?: string;
  frontmatter?: Record<string, unknown>;
  /** Stable id for the note across edits/renames. Defaults to a path/content hash. */
  docId?: string;
  /** Lifespan override; defaults to the durable document lease. */
  expiresInSeconds?: number;
  /**
   * Provenance — the tabular layer that makes recall sharp ON YOUR WORK and
   * enables server-side `arkiv_query` scoping. Stamped as queryable attributes.
   * `project`/`sessionId` are strings (exact-match/glob); `tierLevel` is a NUMBER
   * (0=fresh,1=reinforced,2=core) so `tierLevel >= n` range queries work — Arkiv
   * buckets attributes by JS type and only numerics are range-comparable.
   */
  project?: string;
  sessionId?: string;
  /** Lifecycle tier as a number for range queries. Default 2 (core) — docs are durable. */
  tierLevel?: number;
  /** Optional record kind, e.g. "session-summary", surfaced as a queryable attribute. */
  kind?: string;
  /** When set, stamped as contentHash instead of sha256(text). Used for binary uploads. */
  contentSha256?: string;
  mimeType?: string;
  filename?: string;
}

export interface DocumentCreateResult {
  txHash: Hex;
  entityKey: Hex;
  docId: string;
  contentSha256: string;
}

/** sha-256 hex of a UTF-8 string. */
async function sha256Hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Create one sealed DOCUMENT entity (full text + embeddings). Throws if no
 * wallet key is available. Returns the stable docId + content hash so callers
 * can stamp the Obsidian note back / detect idempotent re-stores.
 */
export async function createDocumentMemory(
  input: DocumentCreateInput,
): Promise<DocumentCreateResult> {
  if (typeof input.text !== "string" || input.text.trim().length === 0) {
    throw new Error("createDocumentMemory: text must be a non-empty string");
  }
  const contentSha256 = input.contentSha256 ?? (await sha256Hex(input.text));
  // Stable id: prefer a path-derived id (survives edits of the same note),
  // else fall back to a content-derived id for ad-hoc stores.
  const docId =
    input.docId ??
    (input.vaultPath
      ? `cx_${(await sha256Hex(input.vaultPath)).slice(0, 16)}`
      : `cx_${contentSha256.slice(0, 16)}`);

  const payload = encodeDocumentPayload({
    text: input.text,
    embedding: input.embedding,
    ...(input.sections ? { sections: input.sections } : {}),
    ...(input.title ? { title: input.title } : {}),
    ...(input.vaultPath ? { vaultPath: input.vaultPath } : {}),
    ...(input.frontmatter ? { frontmatter: input.frontmatter } : {}),
    contentSha256,
  });

  const attributes: Attribute[] = [
    { key: "entityType", value: ENTITY_TYPE.DOCUMENT },
    { key: "docId", value: docId },
    { key: "contentHash", value: contentSha256 },
    { key: "updatedAt", value: Date.now() },
    { key: "schemaVersion", value: DOCUMENT_SCHEMA_VERSION },
    // tierLevel is numeric so `tierLevel >= n` is range-queryable on Arkiv.
    { key: "tierLevel", value: input.tierLevel ?? 2 },
  ];
  if (input.project) attributes.push({ key: WORKSPACE_ATTR, value: input.project });
  if (input.sessionId) attributes.push({ key: "sessionId", value: input.sessionId });
  if (input.kind) attributes.push({ key: "kind", value: input.kind });
  if (input.mimeType) attributes.push({ key: "mimeType", value: input.mimeType });
  if (input.filename) attributes.push({ key: "filename", value: input.filename });

  const { txHash, entityKey } = await createMemory({
    payload,
    attributes,
    contentType: SEALED_CONTENT_TYPE, // replaced by createMemory anyway
    expiresInSeconds: input.expiresInSeconds ?? REINFORCEMENT.documentInitialSeconds,
  });

  return { txHash, entityKey, docId, contentSha256 };
}

/** Batch-create sealed memory entities (one tx). Throws if no wallet key is available. */
export async function createMemories(items: CortexCreate[]): Promise<BatchCreateResult> {
  if (items.length === 0) {
    throw new Error("createMemories called with empty items array");
  }
  const key = await requirePayloadKey();
  const sealedItems = await Promise.all(
    items.map(async (it) => ({
      ...it,
      payload: await sealPayload(key, it.payload),
      contentType: SEALED_CONTENT_TYPE,
    })),
  );
  return batchCreate(sealedItems);
}
