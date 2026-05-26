/**
 * Cortex — OpenClaw memory-plugin adapter (pure logic).
 *
 * These are the bodies of the `memory_recall` / `memory_store` / `memory_forget`
 * tools that the `memory-arkiv` OpenClaw plugin (extensions/memory-arkiv) exposes.
 * They live here, inside Cortex, so they are typechecked and unit-tested with the
 * rest of the engine and carry NO `openclaw` dependency — the plugin shell merely
 * wraps them in `definePluginEntry` + `api.registerTool`.
 *
 * The mapping that makes the fusion real:
 *   memory_recall → Cortex `recall` (decay-aware, utility-weighted, decrypted in RAM)
 *   memory_store  → Cortex `createMemory` (RaBitQ-compressed, sealed on Arkiv)
 *
 * Result shape matches OpenClaw's tool contract: { content: [{ type, text }] }.
 */

import { ExpirationTime } from "@arkiv-network/sdk/utils";
import { recall, type RecallDeps } from "../darwinian/recall.ts";
import { embedAndQuantize } from "../compression/embeddings.ts";
import { createMemory } from "../lib/batch-writer.ts";
import { ENTITY_TYPE, BRAGA } from "../constants.ts";

export interface ToolTextResult {
  content: Array<{ type: "text"; text: string }>;
}

function text(t: string): ToolTextResult {
  return { content: [{ type: "text", text: t }] };
}

export interface MemoryRecallParams {
  query: string;
  k?: number;
  /** Test-only seam forwarded to recall; the plugin shell never sets it. */
  _deps?: RecallDeps;
}

/** memory_recall — surface the top-k Cortex memories for a query. */
export async function memoryRecall(p: MemoryRecallParams): Promise<ToolTextResult> {
  const hits = await recall({ query: p.query, k: p.k ?? 5, _deps: p._deps });
  if (hits.length === 0) {
    return text("No relevant memories found in Cortex.");
  }
  const lines = hits.map(
    (h, i) =>
      `${i + 1}. [${h.entityType}] score ${h.score.toFixed(3)} — ${h.entityKey}` +
      (h.payloadPreview ? `\n   ${h.payloadPreview}` : ""),
  );
  return text(`Recalled ${hits.length} Cortex memories:\n${lines.join("\n")}`);
}

export interface MemoryStoreParams {
  text: string;
}

/** memory_store — RaBitQ-compress, seal, and write an observation to Arkiv. */
export async function memoryStore(p: MemoryStoreParams): Promise<ToolTextResult> {
  if (!p.text || p.text.trim().length === 0) {
    return text("Nothing to store: empty memory text.");
  }
  const { bytes } = await embedAndQuantize(p.text);
  const created = await createMemory({
    payload: bytes,
    contentType: "application/octet-stream", // replaced by SEALED_CONTENT_TYPE
    attributes: [
      { key: "entityType", value: ENTITY_TYPE.OBSERVATION },
      { key: "source", value: "openclaw" },
      { key: "ts", value: Date.now() },
    ],
    expiresInSeconds: ExpirationTime.fromMinutes(60),
  });
  return text(
    `Stored memory ${created.entityKey} (RaBitQ-compressed, sealed on Arkiv). ` +
      `It starts with a 1h lease and grows each time you cite it. ` +
      `tx: ${BRAGA.explorer}tx/${created.txHash}`,
  );
}
