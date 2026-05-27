/**
 * Build Arkiv createEntity parameters for a prepared document upload.
 * Shared by browser sealing and server-side gas quotes.
 */

import type { Attribute } from "@arkiv-network/sdk/types";
import type { CreateEntityParameters } from "@arkiv-network/sdk";
import {
  encodeDocumentPayload,
  DOCUMENT_SCHEMA_VERSION,
} from "../compression/document-payload.ts";
import {
  ENTITY_TYPE,
  PROJECT_ATTRIBUTE,
  REINFORCEMENT,
  SEALED_CONTENT_TYPE,
} from "../constants.ts";
import type { PreparedUpload } from "./store-file-prepare.ts";

/** AES-GCM sealed layout: 12-byte nonce + ciphertext + 16-byte tag. */
export const SEALED_PAYLOAD_OVERHEAD_BYTES = 12 + 16;

export function plainDocumentPayloadBytes(prepared: PreparedUpload): Uint8Array {
  return encodeDocumentPayload({
    text: prepared.text,
    embedding: new Float32Array(prepared.embedding),
    title: prepared.title,
    frontmatter: prepared.frontmatter,
    contentSha256: prepared.contentSha256,
  });
}

export function estimatedSealedPayloadBytes(prepared: PreparedUpload): {
  plainBytes: number;
  sealedBytes: number;
} {
  const plain = plainDocumentPayloadBytes(prepared);
  return {
    plainBytes: plain.length,
    sealedBytes: plain.length + SEALED_PAYLOAD_OVERHEAD_BYTES,
  };
}

export function buildDocumentCreateParams(
  prepared: PreparedUpload,
  payload: Uint8Array,
): CreateEntityParameters {
  const docId = `cx_${prepared.contentSha256.slice(0, 16)}`;
  const attributes: Attribute[] = [
    { key: "project", value: PROJECT_ATTRIBUTE.value },
    { key: "entityType", value: ENTITY_TYPE.DOCUMENT },
    { key: "docId", value: docId },
    { key: "contentHash", value: prepared.contentSha256 },
    { key: "updatedAt", value: Date.now() },
    { key: "schemaVersion", value: DOCUMENT_SCHEMA_VERSION },
    { key: "tierLevel", value: 2 },
    { key: "kind", value: prepared.kind },
    { key: "mimeType", value: prepared.mime },
    { key: "filename", value: prepared.filename },
  ];

  return {
    payload,
    attributes,
    contentType: SEALED_CONTENT_TYPE,
    expiresIn: REINFORCEMENT.documentInitialSeconds,
  };
}
