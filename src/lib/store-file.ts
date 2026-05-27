/**
 * Cortex — store an uploaded file as a Document-tier memory.
 *
 * Text/code/markdown: full UTF-8 text is sealed in the CBOR payload (lossless
 * recall). Images and other binaries: only a recall descriptor + sha256 of the
 * raw bytes is stored — the hash is stamped as `contentHash` on Arkiv.
 *
 * Every upload is embedded so Mapper k-NN edges connect it to related memories.
 */

import { PROJECT_ATTRIBUTE } from "../constants.ts";
import { embedText } from "../compression/embeddings.ts";
import { createDocumentMemory, type DocumentCreateResult } from "./batch-writer.ts";

export const MAX_TEXT_UPLOAD_BYTES = 2 * 1024 * 1024;
/** Binary uploads are hashed locally — bytes are not sealed on-chain. */
export const MAX_BINARY_UPLOAD_BYTES = 25 * 1024 * 1024;

/** @deprecated use MAX_TEXT_UPLOAD_BYTES / MAX_BINARY_UPLOAD_BYTES */
export const MAX_UPLOAD_BYTES = MAX_TEXT_UPLOAD_BYTES;

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".css",
  ".html",
  ".htm",
  ".yaml",
  ".yml",
  ".toml",
  ".sh",
  ".sql",
  ".csv",
  ".xml",
  ".svg",
]);

const MAX_EMBED_CHARS = 32_000;

export function fileExtension(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i === -1 ? "" : filename.slice(i).toLowerCase();
}

/** True when we treat the upload as UTF-8 text (full body sealed + embedded). */
export function isTextLikeUpload(filename: string, mime: string): boolean {
  if (mime.startsWith("text/")) return true;
  if (mime === "application/json" || mime === "application/javascript") return true;
  return TEXT_EXTENSIONS.has(fileExtension(filename));
}

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Recallable descriptor for binary uploads (images, etc.). */
export function buildBinaryRecallText(input: {
  filename: string;
  mime: string;
  bytesSha256: string;
  caption?: string;
}): string {
  const lines = [
    "[cortex-upload]",
    `filename: ${input.filename}`,
    `mime: ${input.mime}`,
    `sha256: ${input.bytesSha256}`,
  ];
  const cap = input.caption?.trim();
  if (cap) {
    lines.push("", cap);
  }
  return lines.join("\n");
}

export interface StoreUploadedFileInput {
  filename: string;
  mime: string;
  bytes: Uint8Array;
  caption?: string;
}

export interface StoreUploadedFileResult extends DocumentCreateResult {
  binary: boolean;
  filename: string;
  mime: string;
}

export async function storeUploadedFile(
  input: StoreUploadedFileInput,
): Promise<StoreUploadedFileResult> {
  if (input.bytes.length === 0) {
    throw new Error("storeUploadedFile: empty file");
  }

  const bytesSha256 = await sha256Bytes(input.bytes);
  const binary = !isTextLikeUpload(input.filename, input.mime);
  const maxBytes = binary ? MAX_BINARY_UPLOAD_BYTES : MAX_TEXT_UPLOAD_BYTES;
  if (input.bytes.length > maxBytes) {
    const mb = (maxBytes / (1024 * 1024)).toFixed(0);
    throw new Error(
      `storeUploadedFile: ${binary ? "binary" : "text"} file exceeds ${mb}MB (${input.bytes.length} bytes). ` +
        (binary
          ? "Only the sha256 is stored on Arkiv for images/binaries."
          : "Text is sealed in full — shrink the file or split into notes."),
    );
  }

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
    if (!text.trim()) {
      throw new Error("storeUploadedFile: text file is empty");
    }
    if (text.length > MAX_EMBED_CHARS) {
      text =
        text.slice(0, MAX_EMBED_CHARS) +
        `\n\n[truncated for embedding; full file hash ${bytesSha256}]`;
    }
  }

  const embedding = await embedText(text);
  const res = await createDocumentMemory({
    text,
    embedding,
    title: input.filename,
    kind: "upload",
    project: PROJECT_ATTRIBUTE.value,
    contentSha256: bytesSha256,
    mimeType: input.mime,
    filename: input.filename,
    frontmatter: {
      upload: true,
      mime: input.mime,
      filename: input.filename,
      bytesLength: input.bytes.length,
      ...(input.caption?.trim() ? { caption: input.caption.trim() } : {}),
    },
  });

  return {
    ...res,
    binary,
    filename: input.filename,
    mime: input.mime,
  };
}
