/**
 * Text → embedding → RaBitQ code pipeline.
 *
 * Provider-resilient via `fetch` (no SDK — one POST, no streaming):
 *   1. OpenRouter (OpenAI-compatible `/api/v1/embeddings`) when OPENROUTER_API_KEY
 *      is set — default model `openai/text-embedding-3-small` (natively 1536-d).
 *   2. Cohere (`embed-v4.0`, output_dimension 1536) when COHERE_API_KEY is set.
 *
 * Single-provider fragility was a real outage (Cohere trial-key 429 exhausted the
 * monthly quota mid-build); the fallback chain exists so one provider's limit
 * can't take the whole engine down. Output is always a 1536-d Float32Array —
 * the compression layer is tuned to exactly 1536 (see src/compression/rabitq.ts),
 * so a wrong-dimension response throws rather than silently corrupting recall.
 *
 * NOTE: embeddings from different providers/models live in different vector
 * spaces — don't mix memories embedded by different providers in one recall.
 */

import { packCode, rabitqEncode } from "./rabitq.ts";
import { publish } from "../lib/events.ts";

const EMBED_DIM = 1536;

const OPENROUTER_EMBED_URL = "https://openrouter.ai/api/v1/embeddings";
// Overridable in case the routed model id differs; default is natively 1536-d.
const OPENROUTER_MODEL = process.env["OPENROUTER_EMBED_MODEL"] ?? "openai/text-embedding-3-small";

const COHERE_EMBED_URL = "https://api.cohere.com/v2/embed";
const COHERE_MODEL = "embed-v4.0";

interface CohereEmbeddingResponse {
  id: string;
  embeddings: { float: number[][] };
  texts: string[];
}

interface OpenAIEmbeddingResponse {
  data: { embedding: number[] }[];
}

function toFloat32(arr: number[], provider: string): Float32Array {
  if (!Array.isArray(arr)) {
    throw new Error(`embedText: unexpected ${provider} response shape`);
  }
  if (arr.length !== EMBED_DIM) {
    throw new Error(
      `embedText: expected ${EMBED_DIM}-d from ${provider}, got ${arr.length}. ` +
        `RaBitQ requires exactly ${EMBED_DIM}-d — set OPENROUTER_EMBED_MODEL to a 1536-d model.`,
    );
  }
  const out = new Float32Array(EMBED_DIM);
  for (let i = 0; i < EMBED_DIM; i++) out[i] = arr[i]!;
  return out;
}

async function embedViaOpenRouter(text: string, apiKey: string): Promise<Float32Array> {
  const res = await fetch(OPENROUTER_EMBED_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      input: [text],
      encoding_format: "float",
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `embedText: OpenRouter request failed ${res.status} ${res.statusText} — ${body.slice(0, 500)}`,
    );
  }
  const json = (await res.json()) as OpenAIEmbeddingResponse;
  const first = json.data?.[0]?.embedding;
  return toFloat32(first as number[], `OpenRouter(${OPENROUTER_MODEL})`);
}

async function embedViaCohere(text: string, apiKey: string): Promise<Float32Array> {
  const res = await fetch(COHERE_EMBED_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: COHERE_MODEL,
      texts: [text],
      input_type: "search_document",
      embedding_types: ["float"],
      output_dimension: EMBED_DIM,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `embedText: Cohere request failed ${res.status} ${res.statusText} — ${body.slice(0, 500)}`,
    );
  }
  const json = (await res.json()) as CohereEmbeddingResponse;
  const first = json.embeddings?.float?.[0];
  return toFloat32(first as number[], "Cohere");
}

export async function embedText(text: string): Promise<Float32Array> {
  if (typeof text !== "string" || text.length === 0) {
    throw new Error("embedText: input text must be a non-empty string");
  }
  const openRouterKey = process.env["OPENROUTER_API_KEY"];
  if (openRouterKey) return embedViaOpenRouter(text, openRouterKey);

  const cohereKey = process.env["COHERE_API_KEY"];
  if (cohereKey) return embedViaCohere(text, cohereKey);

  throw new Error(
    "embedText: no embedding provider configured. Set OPENROUTER_API_KEY (preferred) or COHERE_API_KEY in .env.",
  );
}

/**
 * Full pipeline: text → embedding → RaBitQ code → packed bytes.
 *
 * Returns both the packed bytes (suitable for an Arkiv entity payload) and
 * the raw embedding (needed in-memory for accurate top-k search before
 * falling back to the compressed estimator).
 */
export async function embedAndQuantize(text: string): Promise<{
  bytes: Uint8Array;
  rawEmbedding: Float32Array;
}> {
  const rawEmbedding = await embedText(text);
  // Time the compression step only (not the network embed) — this is the
  // RaBitQ work the dashboard tile visualises.
  const t0 = performance.now();
  const code = rabitqEncode(rawEmbedding);
  const bytes = packCode(code);
  const ms = performance.now() - t0;
  publish({
    type: "rabitq.encoded",
    ts: Date.now(),
    dim: EMBED_DIM,
    bytes: bytes.byteLength,
    ratio: (EMBED_DIM * 4) / bytes.byteLength,
    ms,
  });
  return { bytes, rawEmbedding };
}
