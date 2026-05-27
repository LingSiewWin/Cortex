/**
 * Human-readable previews for sealed Cortex memories (inspector + dashboard).
 */

import { bytesToHex } from "viem";
import { decodeDocumentPayload } from "../compression/document-payload.ts";
import { unpackCode } from "../compression/rabitq.ts";

const RABITQ_PACK_BYTES = 198;
import { ENTITY_TYPE, SEALED_CONTENT_TYPE } from "../constants.ts";
import { openPayload } from "./crypto.ts";
import { getPayloadKey } from "./payload-key.ts";
import type { MirroredEntity } from "../mirror/replay.ts";

const PREVIEW_LIMIT = 400;

export interface MemoryPreview {
  payloadPreview: string | null;
  /** Full recovered text when decryption + decode succeed (documents, rules, uploads). */
  text?: string;
}

function findAttr(
  entity: MirroredEntity,
  key: string,
): string | number | undefined {
  return entity.attributes.find((a) => a.key === key)?.value;
}

function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  const sample = bytes.subarray(0, Math.min(bytes.length, 64));
  let printable = 0;
  for (const b of sample) {
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126)) printable++;
  }
  return printable / sample.length > 0.85;
}

function hexPreview(payload: Uint8Array): string {
  const slice = payload.subarray(0, Math.min(payload.length, 48));
  const hex = bytesToHex(slice);
  return hex + (payload.length > slice.length ? "…" : "");
}

/**
 * Decrypt (when sealed) and decode a mirrored entity into text a human can read.
 */
export async function decodeMemoryPreview(entity: MirroredEntity): Promise<MemoryPreview> {
  const entityType = findAttr(entity, "entityType") as string | undefined;
  let raw = entity.payload ?? undefined;

  if (raw && entity.contentType === SEALED_CONTENT_TYPE) {
    const payloadKey = await getPayloadKey();
    if (!payloadKey) {
      return {
        payloadPreview:
          "Encrypted — adopt your wallet on /console to decrypt this memory locally.",
      };
    }
    try {
      raw = await openPayload(payloadKey, raw);
    } catch {
      return {
        payloadPreview:
          "Could not decrypt — wrong wallet or key not adopted for this server process.",
      };
    }
  }

  if (!raw || raw.length === 0) {
    return { payloadPreview: null };
  }

  if (entityType === ENTITY_TYPE.DOCUMENT) {
    try {
      const doc = decodeDocumentPayload(raw);
      const title = doc.title?.trim();
      const head = title ? `${title}\n\n` : "";
      const body = doc.text.trim();
      const text = head + body;
      return {
        text,
        payloadPreview: text.slice(0, PREVIEW_LIMIT) + (text.length > PREVIEW_LIMIT ? "…" : ""),
      };
    } catch {
      return { payloadPreview: hexPreview(raw) };
    }
  }

  if (entityType === ENTITY_TYPE.RULE) {
    try {
      const ruleText = new TextDecoder("utf-8", { fatal: false }).decode(raw);
      let body = ruleText;
      try {
        const parsed = JSON.parse(ruleText) as { ruleText?: unknown };
        if (typeof parsed?.ruleText === "string") body = parsed.ruleText;
      } catch {
        /* plain text */
      }
      return {
        text: body,
        payloadPreview: body.slice(0, PREVIEW_LIMIT) + (body.length > PREVIEW_LIMIT ? "…" : ""),
      };
    } catch {
      return { payloadPreview: hexPreview(raw) };
    }
  }

  if (entityType === ENTITY_TYPE.OBSERVATION || entityType === ENTITY_TYPE.EPISODE) {
    if (raw.length === RABITQ_PACK_BYTES) {
      try {
        unpackCode(raw);
        const filename = findAttr(entity, "filename");
        const mime = findAttr(entity, "mimeType");
        const cap = findAttr(entity, "caption");
        const parts = [
          "RaBitQ-compressed observation (semantic fingerprint on-chain).",
          filename ? `file: ${filename}` : null,
          mime ? `mime: ${mime}` : null,
          cap ? `caption: ${cap}` : null,
        ].filter(Boolean);
        return { payloadPreview: parts.join(" · ") };
      } catch {
        /* fall through */
      }
    }
  }

  if (looksLikeText(raw)) {
    try {
      const txt = new TextDecoder("utf-8", { fatal: false }).decode(raw);
      return {
        text: txt,
        payloadPreview: txt.slice(0, PREVIEW_LIMIT) + (txt.length > PREVIEW_LIMIT ? "…" : ""),
      };
    } catch {
      /* hex */
    }
  }

  return { payloadPreview: hexPreview(raw) };
}
