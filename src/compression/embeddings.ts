/**
 * Text → embedding → RaBitQ code pipeline.
 *
 * Calls OpenAI `text-embedding-3-large` directly via `fetch`. The output is a
 * 1536-d Float32Array (we request the default dimension; the model supports
 * shortening via the `dimensions` param but our compression layer is tuned to
 * exactly 1536 — see src/compression/rabitq.ts).
 *
 * Why no `openai` SDK: Bun's native `fetch` is fine, and the embedding endpoint
 * is one POST with no streaming. Adding a dependency would be gold-plating.
 */

import { packCode, rabitqEncode } from "./rabitq.ts";
const COHERE_EMBED_URL = "https://api.cohere.com/v2/embed";
const COHERE_MODEL = "embed-v4.0";
const EMBED_DIM = 1536;

interface CohereEmbeddingResponse {
  id: string;
  embeddings: { float: number[][] };
  texts: string[];
}

export async function embedText(text: string): Promise<Float32Array> {
  const apiKey = process.env["COHERE_API_KEY"];
  if (!apiKey) {
    throw new Error("embedText: COHERE_API_KEY is not set. Add it to .env.");
  }
  if (typeof text !== "string" || text.length === 0) {
    throw new Error("embedText: input text must be a non-empty string");
  }

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
  if (!first || !Array.isArray(first)) {
    throw new Error(`embedText: unexpected Cohere response shape`);
  }
  if (first.length !== EMBED_DIM) {
    throw new Error(`embedText: expected ${EMBED_DIM}-d, got ${first.length}`);
  }

  const out = new Float32Array(EMBED_DIM);
  for (let i = 0; i < EMBED_DIM; i++) out[i] = first[i]!;
  return out;
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
  const code = rabitqEncode(rawEmbedding);
  const bytes = packCode(code);
  return { bytes, rawEmbedding };
}
