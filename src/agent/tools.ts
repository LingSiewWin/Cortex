/**
 * Cortex — agent tool surface (OpenAI-style "tools" / "function calling").
 *
 * The Darwinian engine exposes exactly TWO tools to the agent runtime:
 *
 *   1. recall(query, k?, entityType?) → MemoryHit[]
 *   2. act(action, citations) → ActResult
 *
 * Nothing else. No raw "create memory" or "extend memory" knob — those happen
 * implicitly as a side-effect of recall + act. This is the load-bearing
 * constraint that makes the citation-driven reinforcement loop honest: an
 * agent that doesn't recall cannot cite, and citations get validated against
 * the last recall set.
 *
 * Type approach: we define an inline ChatCompletionTool shape that matches the
 * OpenAI spec (also accepted by anthropic-compatible function-calling shims and
 * by most agent runtimes). Avoids pulling in the `openai` npm dep.
 */

import type { Hex } from "@arkiv-network/sdk";
import { recall, type MemoryHit } from "../darwinian/recall.ts";
import { act, type ActResult } from "../darwinian/citation.ts";
import { ENTITY_TYPE } from "../constants.ts";

// ---------------------------------------------------------------------------
// Inline OpenAI-compatible "tools" shape — no npm dep on `openai`.
// ---------------------------------------------------------------------------

/** OpenAI-style JSON-Schema "function" definition. */
export interface FunctionDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** OpenAI-style "tool" wrapper. Compatible with chat.completions tool calling. */
export interface ChatCompletionTool {
  type: "function";
  function: FunctionDefinition;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const recallTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "recall",
    description:
      "Search Cortex's Darwinian memory for memories matching a natural-language query. " +
      "Returns up to k hits, sorted by descending score. Use this BEFORE making any decision " +
      "you want to cite. The IDs returned here are the only ones act() will accept.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description:
            "Natural-language description of what you want to remember. Will be embedded and matched against stored memories.",
        },
        k: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Maximum number of memories to return. Default 5.",
        },
        entityType: {
          type: "string",
          enum: [ENTITY_TYPE.OBSERVATION, ENTITY_TYPE.EPISODE, ENTITY_TYPE.RULE],
          description:
            "Restrict to a single memory tier. Omit for cross-tier recall. " +
            "Use 'rule' for stable principles, 'episode' for replayable scenes, 'observation' for raw facts.",
        },
      },
      required: ["query"],
    },
  },
};

const actTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "act",
    description:
      "Record an action with the memories you actually used. Every cited memory's lifespan grows; " +
      "uncited memories decay. Citations not in your most recent recall() output are silently dropped — " +
      "do NOT invent IDs. This is how Cortex distinguishes useful memories from cruft.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          description:
            "A 1-2 sentence description of the decision you just made. This is for logging — the action is not interpreted further.",
        },
        citations: {
          type: "array",
          items: { type: "string", pattern: "^0x[0-9a-fA-F]+$" },
          description:
            "Entity keys (0x-prefixed hex) of the memories you actually used. Must come from the most recent recall() call.",
        },
      },
      required: ["action", "citations"],
    },
  },
};

/** The full Cortex tool set the agent runtime should pass to the LLM. */
export const cortexToolDefinitions: ChatCompletionTool[] = [recallTool, actTool];

// ---------------------------------------------------------------------------
// Tool dispatcher
// ---------------------------------------------------------------------------

export interface ToolContext {
  /** User's primary EOA — required for tier-promotion ownership transfers. */
  userPrimaryEOA: Hex;
  /** Optional logical session id for distinct-session tracking. */
  sessionId?: string;
}

/**
 * Execute a tool call by name. Returns the raw result; the agent runtime is
 * responsible for serialising it back to the LLM (JSON.stringify is fine).
 *
 * Throws on unknown tool names so the runtime can surface that as a user-
 * visible error rather than silently dropping the call.
 */
export async function executeToolCall(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<MemoryHit[] | ActResult> {
  switch (name) {
    case "recall":
      return executeRecall(args);
    case "act":
      return executeAct(args, ctx);
    default:
      throw new Error(
        `executeToolCall: unknown tool '${name}'. Known tools: recall, act`,
      );
  }
}

function executeRecall(args: Record<string, unknown>): Promise<MemoryHit[]> {
  const query = args["query"];
  if (typeof query !== "string" || query.length === 0) {
    throw new Error("recall: 'query' must be a non-empty string");
  }
  const k = args["k"];
  const entityType = args["entityType"];

  const opts: {
    query: string;
    k?: number;
    entityType?: "observation" | "episode" | "rule";
  } = { query };
  if (typeof k === "number" && Number.isInteger(k) && k > 0) opts.k = k;
  if (
    entityType === ENTITY_TYPE.OBSERVATION ||
    entityType === ENTITY_TYPE.EPISODE ||
    entityType === ENTITY_TYPE.RULE
  ) {
    opts.entityType = entityType;
  }
  return recall(opts);
}

function executeAct(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ActResult> {
  const action = args["action"];
  if (typeof action !== "string" || action.length === 0) {
    throw new Error("act: 'action' must be a non-empty string");
  }
  const rawCitations = args["citations"];
  if (!Array.isArray(rawCitations)) {
    throw new Error("act: 'citations' must be an array of 0x-hex strings");
  }
  const citations: Hex[] = [];
  for (const c of rawCitations) {
    if (typeof c !== "string" || !/^0x[0-9a-fA-F]+$/.test(c)) {
      throw new Error(
        `act: every citation must be a 0x-prefixed hex string, got ${JSON.stringify(c)}`,
      );
    }
    citations.push(c as Hex);
  }

  const opts: {
    action: string;
    citations: Hex[];
    userPrimaryEOA: Hex;
    sessionId?: string;
  } = {
    action,
    citations,
    userPrimaryEOA: ctx.userPrimaryEOA,
  };
  if (ctx.sessionId) opts.sessionId = ctx.sessionId;
  return act(opts);
}
