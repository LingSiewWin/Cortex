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
import { resolveCredentials } from "../lib/credentials.ts";

const EMBED_DIM = 1536;
const EMBED_FETCH_TIMEOUT_MS = 30_000;

// Direct OpenAI — the key most developers already have. 1536-d natively.
const OPENAI_EMBED_URL = "https://api.openai.com/v1/embeddings";
const OPENAI_MODEL = process.env["OPENAI_EMBED_MODEL"] ?? "text-embedding-3-small";

const OPENROUTER_EMBED_URL = "https://openrouter.ai/api/v1/embeddings";
// Overridable in case the routed model id differs; default is natively 1536-d.
const OPENROUTER_MODEL = process.env["OPENROUTER_EMBED_MODEL"] ?? "openai/text-embedding-3-small";

// Voyage AI — Anthropic's officially-recommended embeddings partner (Anthropic
// itself has NO embeddings API, so this is the path for Claude/Anthropic users).
// `voyage-large-2` is natively 1536-d, so RaBitQ stays locked. OpenAI-shaped response.
const VOYAGE_EMBED_URL = "https://api.voyageai.com/v1/embeddings";
const VOYAGE_MODEL = process.env["VOYAGE_EMBED_MODEL"] ?? "voyage-large-2";

const COHERE_EMBED_URL = "https://api.cohere.com/v2/embed";
const COHERE_MODEL = "embed-v4.0";

/**
 * Thrown when NO embedding provider key is configured. Carries a friendly,
 * actionable message (see `embedText`). Callers (the MCP store tools, the
 * capture hook) detect this to show the user exactly what to do rather than a
 * raw stack trace — and to NOT retry, since it won't fix itself by waiting.
 */
export class MissingEmbeddingKeyError extends Error {
  readonly isMissingEmbeddingKey = true as const;
  constructor(message: string) {
    super(message);
    this.name = "MissingEmbeddingKeyError";
  }
}

/** True for a "no embedding key configured" error (survives bundling/serialization). */
export function isMissingEmbeddingKey(err: unknown): boolean {
  return (
    err instanceof MissingEmbeddingKeyError ||
    (typeof err === "object" && err !== null && "isMissingEmbeddingKey" in err)
  );
}

/** Reject README placeholders and empty strings — they pass truthy checks but 401 at runtime. */
export function isUsableEmbeddingKey(key: string | undefined | null): boolean {
  if (typeof key !== "string") return false;
  const v = key.trim();
  if (v.length < 16) return false;
  if (/\.{2,}|…|placeholder|your[-_]?key/i.test(v)) return false;
  return true;
}

/** True if ANY embedding provider key is configured. Lets hooks warn up-front. */
export function hasEmbeddingKey(): boolean {
  return resolveCredentials().embedding !== null;
}

/** The polished, friendly "set your key" message. One place, reused everywhere. */
export const EMBEDDING_SETUP_MESSAGE = [
  "Cortex needs an embedding API key to turn your notes into searchable memory.",
  "",
  "Add ONE of these to your environment (your shell profile, or a .env in your project):",
  "  • OPENAI_API_KEY=sk-…        ← get one at https://platform.openai.com/api-keys",
  "  • OPENROUTER_API_KEY=sk-or-… ← or https://openrouter.ai/keys",
  "  • VOYAGE_API_KEY=…           ← Claude/Anthropic users: Anthropic has no embeddings",
  "                                 API, so use Voyage (their recommended partner):",
  "                                 https://dashboard.voyageai.com/",
  "  • COHERE_API_KEY=…           ← or https://dashboard.cohere.com/api-keys",
  "",
  "Then restart your session. (Your text is only sent to that provider to embed;",
  "the memory itself is encrypted with your wallet and stored on Arkiv.)",
].join("\n");

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

async function embedViaOpenAI(text: string, apiKey: string): Promise<Float32Array> {
  const res = await fetch(OPENAI_EMBED_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(EMBED_FETCH_TIMEOUT_MS),
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: [text],
      // text-embedding-3-* are natively 1536-d at the default; pin it explicitly
      // so an org default can't hand us a different dimension (RaBitQ needs 1536).
      dimensions: EMBED_DIM,
      encoding_format: "float",
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `embedText: OpenAI request failed ${res.status} ${res.statusText} — ${body.slice(0, 500)}`,
    );
  }
  const json = (await res.json()) as OpenAIEmbeddingResponse;
  const first = json.data?.[0]?.embedding;
  return toFloat32(first as number[], `OpenAI(${OPENAI_MODEL})`);
}

async function embedViaOpenRouter(text: string, apiKey: string): Promise<Float32Array> {
  const res = await fetch(OPENROUTER_EMBED_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(EMBED_FETCH_TIMEOUT_MS),
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

async function embedViaVoyage(text: string, apiKey: string): Promise<Float32Array> {
  const res = await fetch(VOYAGE_EMBED_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(EMBED_FETCH_TIMEOUT_MS),
    body: JSON.stringify({
      model: VOYAGE_MODEL,
      input: [text],
      input_type: "document",
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `embedText: Voyage request failed ${res.status} ${res.statusText} — ${body.slice(0, 500)}`,
    );
  }
  // Voyage returns an OpenAI-shaped { data: [{ embedding }] }.
  const json = (await res.json()) as OpenAIEmbeddingResponse;
  const first = json.data?.[0]?.embedding;
  return toFloat32(first as number[], `Voyage(${VOYAGE_MODEL})`);
}

async function embedViaCohere(text: string, apiKey: string): Promise<Float32Array> {
  const res = await fetch(COHERE_EMBED_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(EMBED_FETCH_TIMEOUT_MS),
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
  // Provider + key resolved centrally (env order OpenAI → OpenRouter → Voyage →
  // Cohere, then the ~/.cortex/config.json key routed to its provider). All
  // providers return 1536-d, so RaBitQ stays locked and stable.
  const emb = resolveCredentials().embedding;
  if (!emb) throw new MissingEmbeddingKeyError(EMBEDDING_SETUP_MESSAGE);

  switch (emb.provider) {
    case "openrouter":
      return embedViaOpenRouter(text, emb.key);
    case "voyage":
      return embedViaVoyage(text, emb.key);
    case "cohere":
      return embedViaCohere(text, emb.key);
    case "openai":
    default:
      return embedViaOpenAI(text, emb.key);
  }
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
