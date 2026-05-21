/**
 * Cortex — RaBitQ Playground API handlers.
 *
 * Two endpoints used by the /console page to make the compression algorithm
 * legible to users:
 *
 *   POST /api/playground/encode  → embed text, run the real rabitqEncode +
 *                                  packCode, return diagnostic bytes + timings.
 *   POST /api/playground/recall  → call the real recall() function so users
 *                                  can verify that compressed memories are
 *                                  retrievable from natural-language queries.
 *
 * Why these are pure handlers (Request → Response):
 *   - Keeps the route table in src/ui-server.ts a thin wiring layer.
 *   - Lets tests call the handlers directly with a fabricated Request and a
 *     dependency-injected embedText / recall — no Bun.serve needed.
 *
 * Dependency injection (test seam):
 *   Both handlers accept an optional `deps` parameter. Production calls pass
 *   nothing → defaults wire the real embedText + recall. Tests pass mocks so
 *   we don't burn Cohere quota in CI.
 */

import type { Hex } from "@arkiv-network/sdk";
import { bytesToHex } from "viem";
import { embedText as defaultEmbedText } from "../compression/embeddings.ts";
import {
  packCode,
  rabitqEncode,
  rabitqInnerProduct,
  f16ToF32,
} from "../compression/rabitq.ts";
import { recall as defaultRecall, type MemoryHit } from "../darwinian/recall.ts";

const EMBED_DIM = 1536;
const RAW_BYTES = EMBED_DIM * 4; // 6144 — fp32 wire size of an embedding
const PACK_BYTES = 198;
const HEX_PREVIEW_BYTES = 32;

// ---------------------------------------------------------------------------
// Response shapes (also exported so the frontend + tests can import them).
// ---------------------------------------------------------------------------

export interface PlaygroundEncodeResponse {
  /** Length of the raw fp32 embedding in bytes (always 6144 for D=1536). */
  rawEmbeddingLen: number;
  /** First HEX_PREVIEW_BYTES of the raw fp32 buffer, as `0x…` hex. */
  rawFirstBytes: string;
  /** Full 198-byte RaBitQ pack as `0x…` hex. */
  packedBytes: string;
  /** Always 198 for D=1536. Pinned by `src/compression/rabitq.ts`. */
  packLength: number;
  /** Wall-clock time the encode (rabitqEncode + packCode) took, in ms. */
  encodeTimeMs: number;
  /** Decoded fp16 L2 norm field from the pack — sanity-check value. */
  normFp16: number;
  /** Decoded fp16 alignment factor ⟨ō, o⟩ — denominator of unbiased estimator. */
  alignFp16: number;
  /** rabitqInnerProduct(vec, encode(vec)) — should be very close to ‖vec‖². */
  selfInnerProduct: number;
  /** RAW_BYTES / PACK_BYTES (≈ 31×). Pre-computed so the UI doesn't have to. */
  compressionRatio: number;
}

export interface PlaygroundRecallResponse {
  hits: MemoryHit[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Float32Array view → underlying Uint8Array (no copy). */
function float32ToBytes(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

async function readJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Encode handler
// ---------------------------------------------------------------------------

export interface EncodeDeps {
  /** Substitute for real Cohere/OpenAI calls in tests. */
  embedText?: (text: string) => Promise<Float32Array>;
}

export async function handlePlaygroundEncode(
  req: Request,
  deps: EncodeDeps = {},
): Promise<Response> {
  if (req.method !== "POST") return errorResponse("method not allowed", 405);

  const body = await readJsonBody(req);
  if (
    !body ||
    typeof body !== "object" ||
    typeof (body as { text?: unknown }).text !== "string"
  ) {
    return errorResponse("body must be { text: string }", 400);
  }
  const text = (body as { text: string }).text;
  if (text.length === 0) return errorResponse("text must be non-empty", 400);
  if (text.length > 8192) {
    // Cohere accepts more but we cap to keep the UI snappy.
    return errorResponse("text too long (max 8192 chars)", 400);
  }

  const embed = deps.embedText ?? defaultEmbedText;

  let rawEmbedding: Float32Array;
  try {
    rawEmbedding = await embed(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 503 — the upstream provider is down or no API key configured.
    return errorResponse(`embedText failed: ${msg}`, 503);
  }

  if (rawEmbedding.length !== EMBED_DIM) {
    return errorResponse(
      `embedding length mismatch: expected ${EMBED_DIM}, got ${rawEmbedding.length}`,
      500,
    );
  }

  const t0 = performance.now();
  const code = rabitqEncode(rawEmbedding);
  const bytes = packCode(code);
  const encodeTimeMs = performance.now() - t0;

  // Sanity self-IP — should be close to ‖vec‖² (≈ 1 for unit vectors).
  const selfInnerProduct = rabitqInnerProduct(rawEmbedding, code);

  const rawBytes = float32ToBytes(rawEmbedding);
  const rawFirstBytes = bytesToHex(
    rawBytes.subarray(0, Math.min(rawBytes.length, HEX_PREVIEW_BYTES)),
  );
  const packedBytes = bytesToHex(bytes);

  const resp: PlaygroundEncodeResponse = {
    rawEmbeddingLen: rawBytes.length,
    rawFirstBytes,
    packedBytes,
    packLength: bytes.length,
    encodeTimeMs,
    normFp16: f16ToF32(code.normFp16),
    alignFp16: f16ToF32(code.alignFp16),
    selfInnerProduct,
    compressionRatio: RAW_BYTES / PACK_BYTES,
  };
  return jsonResponse(resp, 200);
}

// ---------------------------------------------------------------------------
// Recall handler
// ---------------------------------------------------------------------------

export interface RecallDeps {
  /** Substitute the real recall() in tests. */
  recall?: typeof defaultRecall;
}

export async function handlePlaygroundRecall(
  req: Request,
  deps: RecallDeps = {},
): Promise<Response> {
  if (req.method !== "POST") return errorResponse("method not allowed", 405);

  const body = await readJsonBody(req);
  if (
    !body ||
    typeof body !== "object" ||
    typeof (body as { query?: unknown }).query !== "string"
  ) {
    return errorResponse("body must be { query: string, k?: number }", 400);
  }
  const b = body as {
    query: string;
    k?: unknown;
    entityType?: unknown;
  };
  if (b.query.length === 0) return errorResponse("query must be non-empty", 400);

  let k = 5;
  if (b.k !== undefined) {
    if (!Number.isInteger(b.k) || (b.k as number) <= 0 || (b.k as number) > 50) {
      return errorResponse("k must be a positive integer ≤ 50", 400);
    }
    k = b.k as number;
  }

  let entityType: "observation" | "episode" | "rule" | undefined;
  if (b.entityType !== undefined) {
    if (
      b.entityType !== "observation" &&
      b.entityType !== "episode" &&
      b.entityType !== "rule"
    ) {
      return errorResponse(
        "entityType must be one of observation|episode|rule",
        400,
      );
    }
    entityType = b.entityType;
  }

  const recallFn = deps.recall ?? defaultRecall;
  try {
    const hits = await recallFn({ query: b.query, k, entityType });
    const resp: PlaygroundRecallResponse = { hits };
    return jsonResponse(resp, 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // recall() throws on missing API key, Arkiv RPC down, etc. 503 makes the
    // UI display a "service unavailable" hint without confusing 4xx semantics.
    return errorResponse(`recall failed: ${msg}`, 503);
  }
}

// Re-export the hit shape so callers can type their state without reaching
// into src/darwinian/recall.ts directly.
export type { MemoryHit, Hex };
