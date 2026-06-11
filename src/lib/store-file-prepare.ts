/**
 * Cortex — prepare a file upload (embed only; no chain write).
 *
 * Browser path: client seals + signs mutateEntities with the connected wallet.
 */

import { embedText, isMissingEmbeddingKey } from "../compression/embeddings";
import {
  buildBinaryRecallText,
  isTextLikeUpload,
  sha256Bytes,
  type StoreUploadedFileInput,
} from "../lib/store-file";
import { PROJECT_ATTRIBUTE } from "../constants";

const MAX_EMBED_CHARS = 32_000;

export interface PreparedUpload {
  text: string;
  embedding: number[];
  contentSha256: string;
  filename: string;
  mime: string;
  binary: boolean;
  title: string;
  kind: "upload";
  project: string;
  frontmatter: Record<string, unknown>;
}

export async function prepareUploadedFile(
  input: StoreUploadedFileInput,
): Promise<PreparedUpload> {
  if (input.bytes.length === 0) throw new Error("empty file");

  const bytesSha256 = await sha256Bytes(input.bytes);
  const binary = !isTextLikeUpload(input.filename, input.mime);

  let text: string;
  if (binary) {
    text = buildBinaryRecallText({
      filename: input.filename,
      mime: input.mime,
      bytesSha256,
      caption: input.caption,
    });
  } else {
    text = new TextDecoder().decode(input.bytes);
    if (!text.trim()) throw new Error("text file is empty");
    if (text.length > MAX_EMBED_CHARS) {
      text =
        text.slice(0, MAX_EMBED_CHARS) +
        `\n\n[truncated for embedding; full file hash ${bytesSha256}]`;
    }
  }

  // SOVEREIGNTY BOUNDARY (be precise in any pitch/marketing): the *payload* is
  // sealed client-side (browser-store-document.ts) and Braga only ever holds
  // ciphertext. But embedding needs a provider key, so on the HOSTED console this
  // `prepare` step runs server-side and the server sees the plaintext `text`
  // momentarily to compute the embedding. So "encrypted client-side" is true;
  // "the server never sees your data" is NOT true for the hosted console.
  // (The plugin path is fully sovereign: it embeds locally with the USER's own
  // key from ~/.cortex/config.json, so no third party ever sees plaintext.)
  // To make the console equally sovereign, embed in-browser with a user-supplied
  // key — tracked as a follow-up; until then, scope the claim to the plugin.
  const embedding = await embedText(text);
  return {
    text,
    embedding: Array.from(embedding),
    contentSha256: bytesSha256,
    filename: input.filename,
    mime: input.mime,
    binary,
    title: input.filename,
    kind: "upload",
    project: PROJECT_ATTRIBUTE.value,
    frontmatter: {
      upload: true,
      mime: input.mime,
      filename: input.filename,
      bytesLength: input.bytes.length,
      ...(input.caption?.trim() ? { caption: input.caption.trim() } : {}),
    },
  };
}

export { isMissingEmbeddingKey };
