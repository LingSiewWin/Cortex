/**
 * POST /api/memories/register — hydrate a wallet-signed create into the mirror
 * and emit memory.created for the live graph + SSE spine.
 */

import type { Hex } from "@arkiv-network/sdk";
import { ENTITY_TYPE } from "../constants.ts";
import { publish } from "../lib/events.ts";
import { hydrateEntityFromChain } from "../mirror/hydrate-one.ts";

const TIER_BY_ENTITY_TYPE: Record<string, "working" | "episodic" | "rule"> = {
  [ENTITY_TYPE.OBSERVATION]: "working",
  [ENTITY_TYPE.EPISODE]: "episodic",
  [ENTITY_TYPE.RULE]: "rule",
  [ENTITY_TYPE.DOCUMENT]: "rule",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function handleMemoryRegisterRequest(req: Request): Promise<Response> {
  let body: { entityKey?: string; txHash?: string };
  try {
    body = (await req.json()) as { entityKey?: string; txHash?: string };
  } catch {
    return json(400, { error: "expected JSON body" });
  }

  const entityKey = body.entityKey;
  if (typeof entityKey !== "string" || !entityKey.startsWith("0x") || entityKey.length < 10) {
    return json(400, { error: "entityKey required (0x-prefixed hex)" });
  }

  const result = await hydrateEntityFromChain(entityKey as Hex);
  if (result.status === "not_cortex") {
    return json(404, { error: "not a Cortex project entity" });
  }
  if (result.status === "evicted") {
    return json(410, { error: "entity already evicted on Arkiv" });
  }
  if (result.status === "error") {
    return json(502, { error: result.message });
  }

  const tier =
    result.entityType && TIER_BY_ENTITY_TYPE[result.entityType]
      ? TIER_BY_ENTITY_TYPE[result.entityType]
      : undefined;
  if (tier) {
    publish({
      type: "memory.created",
      ts: Date.now(),
      entityKey: result.entityKey,
      tier,
      expiresAtBlock: result.expiresAtBlock,
    });
  }

  return json(200, {
    ok: true,
    entityKey: result.entityKey,
    entityType: result.entityType,
    txHash: body.txHash ?? null,
  });
}
