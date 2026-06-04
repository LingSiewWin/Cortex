/**
 * Cortex — minimal MCP server (stdio).
 *
 * Exposes Cortex's two memory primitives to any MCP client (Claude Desktop,
 * Cursor, Cline, …) as the tools shown in the dashboard's Developer Hub:
 *
 *   cortex_recall(query, k?)            → decay-aware semantic recall
 *   cortex_act(action, citations[])     → record a decision + reinforce cited
 *                                         memories (accumulative lease extend)
 *
 * It reuses the SAME engine the live dashboard runs — `recall` (via the shared
 * openclaw adapter body) and `act` — so a citation here evolves the exact same
 * SQLite Darwinian state and enqueues the same on-chain bundle to the shared
 * outbox. When the Cortex dashboard/anchor-worker is running against the same
 * mirror, those bundles drain to Braga; standalone, the local reinforcement is
 * committed immediately (optimistic) and anchors when a worker next drains.
 *
 * Grounded in @modelcontextprotocol/sdk@1.29 (verified against the installed
 * .d.ts): `registerTool(name, { description, inputSchema }, cb)` where
 * inputSchema is a Zod RAW SHAPE, and the handler returns
 * `{ content: [{ type: "text", text }] }`.
 *
 * stdio protocol safety: an MCP stdio server may only write JSON-RPC frames to
 * stdout. Any stray `console.log` from deep in the engine would corrupt the
 * stream, so we route console.log → stderr before touching the engine.
 */

// --- stdout guard: keep stdout pure JSON-RPC (must run before engine code) ---
// eslint-disable-next-line no-console
console.log = (...args: unknown[]) => console.error(...args);

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Hex } from "@arkiv-network/sdk";
import { memoryRecall } from "../openclaw/adapter.ts";
import { act } from "../darwinian/citation.ts";
import { createDocumentMemory } from "../lib/batch-writer.ts";
import { storeSessionSummary } from "../agent/session-summary.ts";
import { embedText, isMissingEmbeddingKey } from "../compression/embeddings.ts";
import { resolveCredentials } from "../lib/credentials.ts";
import { BRAGA } from "../constants.ts";

const VERSION = "0.1.0";

const server = new McpServer({
  name: "cortex-memory",
  version: VERSION,
});

// --- cortex_recall ---------------------------------------------------------
server.registerTool(
  "cortex_recall",
  {
    title: "Cortex recall",
    description:
      "Decay-aware semantic recall over your wallet-owned Cortex memory. " +
      "Returns the top-k candidate memories (id + tier + score + preview). " +
      "Cite the returned ids in cortex_act to reinforce the ones you actually used.",
    inputSchema: {
      query: z.string().min(1).describe("What to recall — a natural-language cue."),
      k: z
        .number()
        .int()
        .positive()
        .max(50)
        .optional()
        .describe("How many candidates to return (default 5)."),
      project: z
        .string()
        .optional()
        .describe("Boost memories from this project (hybrid recall — sharper on your current work)."),
      sessionId: z
        .string()
        .optional()
        .describe("Boost memories from this session (continuity — picks up where you left off)."),
    },
  },
  async ({ query, k, project, sessionId }) => {
    // Reuses the exact recall path the dashboard + OpenClaw plugin use. This
    // also sets the in-process "last recall" set that cortex_act validates
    // citations against (hallucinated ids are dropped). Re-map the adapter's
    // result into the SDK's CallToolResult content shape.
    const r = await memoryRecall({
      query,
      k: k ?? 5,
      ...(project ? { project } : {}),
      ...(sessionId ? { sessionId } : {}),
    });
    return {
      content: r.content.map((c) => ({ type: "text" as const, text: c.text })),
    };
  },
);

// --- cortex_act ------------------------------------------------------------
server.registerTool(
  "cortex_act",
  {
    title: "Cortex act",
    description:
      "Record a decision and cite the memories that informed it. Each valid " +
      "citation fires an accumulative lease extension (+24h per citation) " +
      "so useful memories survive and the rest decay for free. Citations are " +
      "validated against the most recent cortex_recall in this session.",
    inputSchema: {
      action: z.string().min(1).describe("The decision/action being taken."),
      citations: z
        .array(z.string())
        .describe("Entity ids from the latest cortex_recall that you used."),
    },
  },
  async ({ action, citations }) => {
    // Owner EOA resolves env → ~/.cortex/config.json (written by `cortex auth`).
    // Previously env-only, which broke cortex_act for every fresh installer.
    const userPrimaryEOA = (resolveCredentials().ownerEOA ?? undefined) as Hex | undefined;
    if (!userPrimaryEOA) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text:
              "cortex_act unavailable: no owner wallet. Run `cortex auth` (writes your " +
              "owner address to ~/.cortex/config.json) or set USER_PRIMARY_ADDRESS. " +
              "Cortex needs the owner EOA to attribute tier promotions.",
          },
        ],
      };
    }

    const res = await act({
      action,
      citations: citations as Hex[],
      userPrimaryEOA,
    });

    if (res.status === "noop") {
      return {
        content: [
          {
            type: "text" as const,
            text:
              "No citation survived validation — none of the given ids were in the last cortex_recall. " +
              "Nothing reinforced (call cortex_recall first, then cite from its results).",
          },
        ],
      };
    }

    const lines = [
      `Recorded decision: "${action}"`,
      `Reinforced ${res.extendedKeys.length} memory(ies) — leases extended (accumulative).`,
      res.promotedKeys.length > 0
        ? `Promoted ${res.promotedKeys.length} to a higher tier.`
        : null,
      `On-chain citation bundle queued (outbox #${res.outboxId}); anchors when a Cortex worker drains it.`,
      res.citationPayloadHashHex
        ? `MMR leaf (citation hash): ${res.citationPayloadHashHex}`
        : null,
    ].filter(Boolean);

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
);

// --- cortex_store_document -------------------------------------------------
server.registerTool(
  "cortex_store_document",
  {
    title: "Cortex store document",
    description:
      "Store a full-text document (e.g. an Obsidian note) in the Document Tier: " +
      "the FULL text + its embeddings are RaBitQ-compressed, sealed with your " +
      "wallet-derived key, and written to Arkiv with a durable lease — so the note " +
      "is recoverable from your wallet alone (lossless), not just a fingerprint. " +
      "Use this for notes/docs you want to own sovereignly; use the agent's normal " +
      "observation path for ephemeral memories.",
    inputSchema: {
      text: z.string().min(1).describe("The full document/note text (preserved losslessly)."),
      title: z.string().optional().describe("Note title (sealed, for round-trip)."),
      vaultPath: z
        .string()
        .optional()
        .describe("Obsidian vault path, e.g. work/Cortex.md (sealed; gives a stable docId)."),
      project: z.string().optional().describe("Project/thread this belongs to (provenance for scoped recall)."),
      sessionId: z.string().optional().describe("Session id (provenance)."),
    },
  },
  async ({ text, title, vaultPath, project, sessionId }) => {
    try {
      const embedding = await embedText(text);
      const res = await createDocumentMemory({
        text,
        embedding,
        ...(title ? { title } : {}),
        ...(vaultPath ? { vaultPath } : {}),
        ...(project ? { project } : {}),
        ...(sessionId ? { sessionId } : {}),
      });
      const explorer = `${BRAGA.explorer}tx/${res.txHash}`;
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Stored document on Arkiv (Document Tier, durable lease).\n` +
              `  docId:      ${res.docId}\n` +
              `  entityKey:  ${res.entityKey}\n` +
              `  txHash:     ${res.txHash}\n` +
              `  contentSha: ${res.contentSha256}\n` +
              `  explorer:   ${explorer}\n` +
              `The full text + embeddings are sealed (wallet-derived AES-256-GCM); ` +
              `recoverable from your wallet alone. Recall it with cortex_recall.`,
          },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Missing embedding key = setup, not failure — show the friendly guide as-is.
      if (isMissingEmbeddingKey(err)) {
        return { content: [{ type: "text" as const, text: `⚙️ Cortex setup needed\n\n${msg}` }] };
      }
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text:
              `cortex_store_document failed: ${msg}\n` +
              `(Needs a configured wallet: SESSION_KEY_PRIVATE_KEY for the write + ` +
              `CORTEX_USER_SIGNATURE or CORTEX_USER_PRIVATE_KEY to derive the seal key, ` +
              `plus an embedding provider key.)`,
          },
        ],
      };
    }
  },
);

// --- cortex_summarize_session ----------------------------------------------
server.registerTool(
  "cortex_summarize_session",
  {
    title: "Cortex summarize session",
    description:
      "Call at the END of a working session (or on context-window compaction): " +
      "compress what happened into a short summary and Cortex seals it as ONE " +
      "durable, provenance-stamped memory. Next session, recall scoped to the same " +
      "project surfaces it first — so you never re-explain yourself. YOU write the " +
      "summary (you know the conversation); Cortex stores it losslessly + searchably.",
    inputSchema: {
      summary: z
        .string()
        .min(1)
        .describe("The compressed session summary you authored (decisions, state, next steps)."),
      sessionId: z.string().min(1).describe("Stable session id (one summary per session)."),
      project: z.string().optional().describe("Project/thread this session belongs to."),
      title: z.string().optional().describe("Optional human title for the summary."),
    },
  },
  async ({ summary, sessionId, project, title }) => {
    try {
      const res = await storeSessionSummary({
        summary,
        sessionId,
        ...(project ? { project } : {}),
        ...(title ? { title } : {}),
      });
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Session summary sealed on Arkiv (Reinforced tier, provenance-stamped).\n` +
              `  docId:     ${res.docId}\n` +
              `  entityKey: ${res.entityKey}\n` +
              `  txHash:    ${res.txHash}\n` +
              `  explorer:  ${BRAGA.explorer}tx/${res.txHash}\n` +
              `Next session: cortex_recall with project="${project ?? "<project>"}" surfaces this first.`,
          },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isMissingEmbeddingKey(err)) {
        return { content: [{ type: "text" as const, text: `⚙️ Cortex setup needed\n\n${msg}` }] };
      }
      return {
        isError: true,
        content: [{ type: "text" as const, text: `cortex_summarize_session failed: ${msg}` }],
      };
    }
  },
);

// --- boot ------------------------------------------------------------------
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Banner to stderr (stdout is reserved for JSON-RPC).
  console.error(
    `[cortex/mcp] cortex-memory v${VERSION} online (stdio) — tools: cortex_recall, cortex_act, cortex_store_document, cortex_summarize_session`,
  );
}

main().catch((err) => {
  console.error("[cortex/mcp] fatal:", err);
  process.exit(1);
});
