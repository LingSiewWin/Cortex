/**
 * Hydrate a single Cortex entity from Braga into the SQLite mirror.
 *
 * Browser wallet uploads skip the mirror daemon's event subscription, so the
 * console calls this after a successful mutateEntities to make recall, topology,
 * and the inspector see the new memory immediately.
 */

import type { Hex } from "@arkiv-network/sdk";
import { keccak256, bytesToHex } from "viem";
import { getPublicClient } from "../lib/arkiv-client.ts";
import { PROJECT_ATTRIBUTE, ENTITY_TYPE } from "../constants.ts";
import { appendToStateMMR } from "./state.ts";
import {
  initMirrorDb,
  setMembership,
  setPayloadHash,
  encodeAttributes,
  type EventType,
} from "./db.ts";

export type HydrateOneResult =
  | { status: "ok"; entityKey: Hex; entityType: string | null; expiresAtBlock: number }
  | { status: "not_cortex" }
  | { status: "evicted" }
  | { status: "error"; message: string };

export async function hydrateEntityFromChain(
  entityKey: Hex,
  opts?: { eventType?: EventType; blockNumber?: number },
): Promise<HydrateOneResult> {
  const eventType = opts?.eventType ?? "Created";
  try {
    const publicClient = getPublicClient();
    const entity = await publicClient.getEntity(entityKey);
    const hasProjectAttr = entity.attributes.some(
      (a) => a.key === PROJECT_ATTRIBUTE.key && a.value === PROJECT_ATTRIBUTE.value,
    );

    const db = await initMirrorDb();
    setMembership(db, entityKey, hasProjectAttr);
    if (!hasProjectAttr) return { status: "not_cortex" };

    const blockNumber =
      opts?.blockNumber ??
      (entity.lastModifiedAtBlock ? Number(entity.lastModifiedAtBlock) : 0);

    db.prepare(
      "INSERT INTO entities (entity_key, owner, creator, content_type, payload, attributes_json, " +
        "expires_at_block, created_at_block, last_modified_at_block, state, first_seen_block, " +
        "last_event_block, last_event_type, hydrated_at_ms) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', ?, ?, ?, ?) " +
        "ON CONFLICT(entity_key) DO UPDATE SET " +
        "  owner = excluded.owner, " +
        "  creator = COALESCE(entities.creator, excluded.creator), " +
        "  content_type = excluded.content_type, " +
        "  payload = excluded.payload, " +
        "  attributes_json = excluded.attributes_json, " +
        "  expires_at_block = excluded.expires_at_block, " +
        "  last_modified_at_block = excluded.last_modified_at_block, " +
        "  last_event_block = excluded.last_event_block, " +
        "  last_event_type = excluded.last_event_type, " +
        "  hydrated_at_ms = excluded.hydrated_at_ms",
    ).run(
      entityKey,
      entity.owner ?? null,
      entity.creator ?? null,
      entity.contentType ?? null,
      entity.payload ?? null,
      encodeAttributes(entity.attributes),
      Number(entity.expiresAtBlock ?? 0),
      entity.createdAtBlock ? Number(entity.createdAtBlock) : null,
      entity.lastModifiedAtBlock ? Number(entity.lastModifiedAtBlock) : blockNumber,
      blockNumber,
      blockNumber,
      eventType,
      Date.now(),
    );

    const entityType =
      (entity.attributes.find((a) => a.key === "entityType")?.value as string | undefined) ??
      null;
    const isStateRoot = entityType === ENTITY_TYPE.STATE_ROOT;
    if (entity.payload && entity.payload.byteLength > 0 && !isStateRoot) {
      try {
        const hashHex = bytesToHex(keccak256(entity.payload, "bytes"));
        setPayloadHash(db, entityKey, hashHex);
        void appendToStateMMR(hashHex).catch(() => {
          /* best-effort */
        });
      } catch {
        /* non-fatal */
      }
    }

    return {
      status: "ok",
      entityKey,
      entityType,
      expiresAtBlock: Number(entity.expiresAtBlock ?? 0),
    };
  } catch (err) {
    const errName = (err as { name?: string })?.name;
    if (errName === "NoEntityFoundError") {
      try {
        const db = await initMirrorDb();
        setMembership(db, entityKey, false);
      } catch {
        /* ignore */
      }
      return { status: "evicted" };
    }
    return {
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
