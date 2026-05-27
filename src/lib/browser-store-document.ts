/**
 * Build a sealed document entity for browser-signed Braga writes.
 */

import type { Attribute } from "@arkiv-network/sdk/types";
import type { CreateEntityParameters } from "@arkiv-network/sdk";
import {
  encodeDocumentPayload,
  DOCUMENT_SCHEMA_VERSION,
} from "../compression/document-payload";
import {
  ENTITY_TYPE,
  PROJECT_ATTRIBUTE,
  REINFORCEMENT,
  SEALED_CONTENT_TYPE,
} from "../constants";
import { sealPayload } from "./crypto";
import type { PreparedUpload } from "./store-file-prepare";

async function sha256Hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function buildSealedDocumentCreate(input: {
  prepared: PreparedUpload;
  payloadKey: CryptoKey;
}): Promise<CreateEntityParameters> {
  const { prepared, payloadKey } = input;
  const contentSha256 = prepared.contentSha256;
  const docId = `cx_${contentSha256.slice(0, 16)}`;
  const embedding = new Float32Array(prepared.embedding);

  const payloadPlain = encodeDocumentPayload({
    text: prepared.text,
    embedding,
    title: prepared.title,
    frontmatter: prepared.frontmatter,
    contentSha256,
  });

  const sealed = await sealPayload(payloadKey, payloadPlain);

  const attributes: Attribute[] = [
    { key: "project", value: PROJECT_ATTRIBUTE.value },
    { key: "entityType", value: ENTITY_TYPE.DOCUMENT },
    { key: "docId", value: docId },
    { key: "contentHash", value: contentSha256 },
    { key: "updatedAt", value: Date.now() },
    { key: "schemaVersion", value: DOCUMENT_SCHEMA_VERSION },
    { key: "tierLevel", value: 2 },
    { key: "kind", value: prepared.kind },
    { key: "mimeType", value: prepared.mime },
    { key: "filename", value: prepared.filename },
  ];

  return {
    payload: sealed,
    attributes,
    contentType: SEALED_CONTENT_TYPE,
    expiresIn: REINFORCEMENT.documentInitialSeconds,
  };
}

export async function docIdForPrepared(prepared: PreparedUpload): Promise<string> {
  return `cx_${prepared.contentSha256.slice(0, 16)}`;
}

export { sha256Hex };
