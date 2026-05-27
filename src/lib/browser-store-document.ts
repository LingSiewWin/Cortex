/**
 * Build a sealed document entity for browser-signed Braga writes.
 */

import type { CreateEntityParameters } from "@arkiv-network/sdk";
import { buildDocumentCreateParams, plainDocumentPayloadBytes } from "./document-create-params";
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
  const payloadPlain = plainDocumentPayloadBytes(prepared);
  const sealed = await sealPayload(payloadKey, payloadPlain);
  return buildDocumentCreateParams(prepared, sealed);
}

export async function docIdForPrepared(prepared: PreparedUpload): Promise<string> {
  return `cx_${prepared.contentSha256.slice(0, 16)}`;
}

export { sha256Hex };
