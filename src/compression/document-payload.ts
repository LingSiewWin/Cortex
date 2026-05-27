/**
 * Cortex — Document Tier dual payload codec (CBOR).
 *
 * The opt-in Document Tier (Obsidian notes, long-form text) stores BOTH the full
 * human-readable text AND its embeddings, so a user's vault is recoverable from
 * their wallet alone — not just lossy fingerprints. The decoded bytes are then
 * sealed (AES-256-GCM, wallet-derived key) by the normal `createMemory` path, so
 * the chain + mirror hold ciphertext; only `recall` (with the wallet key) opens
 * and decodes this.
 *
 * Wire shape (CBOR map, sealed):
 *   { v, t:"document", text, code, emb, sections?, title?, path?, fm?, sha }
 *     v     : schema version (1)
 *     text  : full UTF-8 note text (lossless — the sovereignty payload)
 *     code  : packed 1-bit RaBitQ code of the whole-note embedding (stage-1 search)
 *     emb   : f16 bytes of the whole-note 1536-d embedding (stage-2 full-precision rerank)
 *     sections? : [{ h:heading, o:char-offset, code:packed }] for passage-level recall
 *                 WITHOUT exploding into N on-chain entities (atomic recovery)
 *     title?, path?, fm? : Obsidian round-trip metadata (sealed — never on-chain plaintext)
 *     sha   : sha-256 hex of the on-disk note (round-trip integrity gate)
 *
 * Why one entity, sections-inside: atomic, verifiable recovery (one sha, one
 * getEntity, decodes whole-or-nothing) + passage-level recall granularity, at one
 * ~29k-gas CREATE instead of N. See docs/TDA/decision-recall-and-mapper.md and the
 * Document Tier design debate.
 */

import { encode as cborEncode, decode as cborDecode } from "cbor-x";
import { packCode, rabitqEncode, f32ToF16, f16ToF32 } from "./rabitq.ts";

export const DOCUMENT_SCHEMA_VERSION = 1;
const EMBED_DIM = 1536;

export interface DocumentSectionInput {
  /** Section heading (or a synthetic label). */
  heading: string;
  /** Character offset of the section start within `text`. */
  offset: number;
  /** The section's own embedding (full-precision; we keep only its packed code). */
  embedding: Float32Array;
}

export interface DocumentPayloadInput {
  text: string;
  /** Whole-note 1536-d embedding (full precision). */
  embedding: Float32Array;
  /** Optional passage-level sections for finer recall. */
  sections?: DocumentSectionInput[];
  title?: string;
  vaultPath?: string;
  frontmatter?: Record<string, unknown>;
  /** sha-256 hex of the source note (round-trip integrity). */
  contentSha256: string;
}

export interface DecodedDocumentPayload {
  v: number;
  text: string;
  /** Packed 1-bit RaBitQ code of the whole-note embedding (stage-1 Hamming). */
  code: Uint8Array;
  /** Full-precision (from f16) whole-note embedding for stage-2 rerank. */
  rerankEmbedding: Float32Array;
  sections: { heading: string; offset: number; code: Uint8Array }[];
  title?: string;
  vaultPath?: string;
  frontmatter?: Record<string, unknown>;
  contentSha256: string;
}

/** Float32Array → little-endian f16 byte string (2 bytes/dim). */
function f32ToF16Bytes(vec: Float32Array): Uint8Array {
  const u16 = new Uint16Array(vec.length);
  for (let i = 0; i < vec.length; i++) u16[i] = f32ToF16(vec[i]!);
  // Copy into a byte view (endianness is consistent on the same machine class;
  // we always read it back with the matching DataView path below to be safe).
  const out = new Uint8Array(u16.length * 2);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < u16.length; i++) dv.setUint16(i * 2, u16[i]!, true /* little-endian */);
  return out;
}

/** Little-endian f16 byte string → Float32Array. */
function f16BytesToF32(bytes: Uint8Array, dim = EMBED_DIM): Float32Array {
  const out = new Float32Array(dim);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < dim; i++) out[i] = f16ToF32(dv.getUint16(i * 2, true));
  return out;
}

/**
 * Build the (pre-seal) CBOR bytes for a document entity. The caller seals the
 * result (createMemory does this) before it touches Arkiv.
 */
export function encodeDocumentPayload(input: DocumentPayloadInput): Uint8Array {
  if (typeof input.text !== "string" || input.text.length === 0) {
    throw new Error("encodeDocumentPayload: text must be a non-empty string");
  }
  if (input.embedding.length !== EMBED_DIM) {
    throw new Error(
      `encodeDocumentPayload: embedding must be ${EMBED_DIM}-d, got ${input.embedding.length}`,
    );
  }
  const obj: Record<string, unknown> = {
    v: DOCUMENT_SCHEMA_VERSION,
    t: "document",
    text: input.text,
    code: packCode(rabitqEncode(input.embedding)),
    emb: f32ToF16Bytes(input.embedding),
    sha: input.contentSha256,
  };
  if (input.sections && input.sections.length > 0) {
    obj.sections = input.sections.map((s) => ({
      h: s.heading,
      o: s.offset,
      code: packCode(rabitqEncode(s.embedding)),
    }));
  }
  if (input.title) obj.title = input.title;
  if (input.vaultPath) obj.path = input.vaultPath;
  if (input.frontmatter) obj.fm = input.frontmatter;

  return new Uint8Array(cborEncode(obj));
}

/** True if the opened (decrypted) bytes look like a Document Tier CBOR payload. */
export function isDocumentPayload(bytes: Uint8Array): boolean {
  // CBOR maps start with major type 5 (0xa0–0xbf). Cheap pre-check before a full
  // decode; recall already knows the entityType, this is defense-in-depth.
  return bytes.length > 1 && bytes[0]! >= 0xa0 && bytes[0]! <= 0xbf;
}

/** Parse the (decrypted) CBOR bytes of a document entity. */
export function decodeDocumentPayload(bytes: Uint8Array): DecodedDocumentPayload {
  const obj = cborDecode(bytes) as Record<string, unknown>;
  if (!obj || obj.t !== "document") {
    throw new Error("decodeDocumentPayload: not a document payload");
  }
  const text = obj.text;
  const code = obj.code;
  const emb = obj.emb;
  if (typeof text !== "string") throw new Error("decodeDocumentPayload: missing text");
  if (!(code instanceof Uint8Array)) throw new Error("decodeDocumentPayload: missing code");
  if (!(emb instanceof Uint8Array)) throw new Error("decodeDocumentPayload: missing emb");

  const rawSections = Array.isArray(obj.sections) ? (obj.sections as Array<Record<string, unknown>>) : [];
  const sections = rawSections
    .filter((s) => s.code instanceof Uint8Array)
    .map((s) => ({
      heading: typeof s.h === "string" ? s.h : "",
      offset: typeof s.o === "number" ? s.o : 0,
      code: s.code as Uint8Array,
    }));

  return {
    v: typeof obj.v === "number" ? obj.v : 0,
    text,
    code,
    rerankEmbedding: f16BytesToF32(emb),
    sections,
    title: typeof obj.title === "string" ? obj.title : undefined,
    vaultPath: typeof obj.path === "string" ? obj.path : undefined,
    frontmatter:
      obj.fm && typeof obj.fm === "object" ? (obj.fm as Record<string, unknown>) : undefined,
    contentSha256: typeof obj.sha === "string" ? obj.sha : "",
  };
}
