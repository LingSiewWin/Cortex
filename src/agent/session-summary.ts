/**
 * Cortex — session-summary capture (episodic continuity).
 *
 * The single highest-ROI memory for the "never re-explain yourself" promise.
 * At the end of a working session (or on context-window compaction), the
 * assistant compresses the session into a short summary and calls this — we
 * embed + seal it as ONE durable, provenance-stamped Document-Tier memory.
 *
 * This is the lecturer's "episodic memory: compress session history into a
 * structured summary" (docs/memory-for-agent), realized as a sovereign Arkiv
 * entity rather than a per-tool silo. The COMPRESSION happens in the assistant
 * (it knows the conversation); we just store the result losslessly + searchably.
 *
 * Tier: `tierLevel: 1` (Reinforced) — a session summary is continuity, more
 * durable than a Fresh observation but not Core knowledge; it surfaces in the
 * next session's recall scoped to the same project (see hybrid recall).
 */

import { createDocumentMemory, type DocumentCreateResult } from "../lib/batch-writer.ts";
import { embedText } from "../compression/embeddings.ts";

export interface SessionSummaryInput {
  /** The compressed session summary text (authored by the assistant). */
  summary: string;
  /** Logical session id — also the stable docId so a session has one summary. */
  sessionId: string;
  /** Project/thread this session belongs to (provenance for scoped recall). */
  project?: string;
  /** Optional human title; defaults to "Session summary — <sessionId>". */
  title?: string;
}

/**
 * Store a session summary as a sealed, provenance-stamped Document-Tier memory.
 * Idempotent per session: docId = `cx_session_<sessionId>`, so re-summarizing
 * the same session overwrites rather than duplicating.
 */
export async function storeSessionSummary(
  input: SessionSummaryInput,
): Promise<DocumentCreateResult> {
  if (typeof input.summary !== "string" || input.summary.trim().length === 0) {
    throw new Error("storeSessionSummary: summary must be a non-empty string");
  }
  if (typeof input.sessionId !== "string" || input.sessionId.length === 0) {
    throw new Error("storeSessionSummary: sessionId is required");
  }
  const embedding = await embedText(input.summary);
  return createDocumentMemory({
    text: input.summary,
    embedding,
    title: input.title ?? `Session summary — ${input.sessionId}`,
    docId: `cx_session_${input.sessionId}`,
    sessionId: input.sessionId,
    ...(input.project ? { project: input.project } : {}),
    kind: "session-summary",
    tierLevel: 1, // Reinforced: durable continuity, not Core knowledge.
  });
}
