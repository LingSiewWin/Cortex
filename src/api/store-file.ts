/**
 * Cortex — POST /api/store-file (multipart).
 *
 * Upload a file from /console judge mode. Text/code/markdown is sealed losslessly;
 * images and other binaries are indexed by filename + mime + sha256 (user-approved).
 *
 * Same auth gates as POST /api/seed-memories.
 */

import type { Hex } from "@arkiv-network/sdk";
import { getEffective } from "../agent/owner-identity";
import { storeUploadedFile } from "../lib/store-file";
import { prepareUploadedFile, isMissingEmbeddingKey } from "../lib/store-file-prepare";
import { quotePreparedUpload } from "../lib/upload-quote.ts";
import type { Address } from "viem";
import { withTimeout } from "../lib/timeouts";

export interface SiweSessionLike {
  address: Hex;
}

type SiweLookup = (cookieValue: string) => SiweSessionLike | null;

let _siweLookup: SiweLookup | null = null;

export function setStoreFileSiweSessionLookup(lookup: SiweLookup): void {
  _siweLookup = lookup;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const t = part.trim();
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    if (t.slice(0, eq) === name) return t.slice(eq + 1);
  }
  return null;
}

async function requireAdoptedViewer(req: Request): Promise<
  | { ok: true; viewer: SiweSessionLike }
  | { ok: false; response: Response }
> {
  const sessionId = readCookie(req, "cortex_session");
  if (!sessionId) {
    return { ok: false, response: json(401, { error: "sign in with wallet first (no SIWE session)" }) };
  }
  const viewer = _siweLookup ? _siweLookup(sessionId) : null;
  if (!viewer) {
    return { ok: false, response: json(401, { error: "SIWE session not found or expired" }) };
  }

  const view = await getEffective();
  if (view.source !== "browser" || !view.ownerAddress) {
    return {
      ok: false,
      response: json(409, {
        error: "no adopted wallet — connect + adopt on /console first.",
      }),
    };
  }
  if (view.ownerAddress.toLowerCase() !== viewer.address.toLowerCase()) {
    return {
      ok: false,
      response: json(403, { error: "SIWE'd address does not match the adopted wallet" }),
    };
  }

  return { ok: true, viewer };
}

export async function handleStoreFileRequest(req: Request): Promise<Response> {
  const auth = await requireAdoptedViewer(req);
  if (!auth.ok) return auth.response;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json(400, { error: "expected multipart/form-data" });
  }

  const raw = form.get("file");
  if (!(raw instanceof File)) {
    return json(400, { error: 'missing "file" field' });
  }

  const captionRaw = form.get("caption");
  const caption = typeof captionRaw === "string" && captionRaw.trim() ? captionRaw.trim() : undefined;

  const bytes = new Uint8Array(await raw.arrayBuffer());
  const filename = raw.name.trim() || "upload";
  const mime = raw.type.trim() || "application/octet-stream";

  try {
    const result = await withTimeout(
      () => storeUploadedFile({ filename, mime, bytes, caption }),
      120_000,
      "store-file (embed + Braga write)",
    );
    return json(200, {
      txHash: result.txHash,
      entityKey: result.entityKey,
      docId: result.docId,
      contentSha256: result.contentSha256,
      filename: result.filename,
      mime: result.mime,
      binary: result.binary,
    });
  } catch (err) {
    if (isMissingEmbeddingKey(err)) {
      return json(503, {
        error: err instanceof Error ? err.message : String(err),
        code: "missing_embedding_key",
      });
    }
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes("exceeds") ? 413 : 500;
    return json(status, { error: message });
  }
}

/** Embed + metadata only — client seals and signs on Braga (official wallet sketch flow). */
export async function handleStoreFilePrepareRequest(req: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json(400, { error: "expected multipart/form-data" });
  }

  const raw = form.get("file");
  if (!(raw instanceof File)) {
    return json(400, { error: 'missing "file" field' });
  }

  const captionRaw = form.get("caption");
  const caption = typeof captionRaw === "string" && captionRaw.trim() ? captionRaw.trim() : undefined;
  const bytes = new Uint8Array(await raw.arrayBuffer());
  const filename = raw.name.trim() || "upload";
  const mime = raw.type.trim() || "application/octet-stream";

  const url = new URL(req.url);
  const ownerParam = url.searchParams.get("owner");
  const owner =
    ownerParam && ownerParam.startsWith("0x") && ownerParam.length >= 10
      ? (ownerParam as Address)
      : undefined;

  try {
    const prepared = await withTimeout(
      () => prepareUploadedFile({ filename, mime, bytes, caption }),
      45_000,
      "store-file/prepare (embed)",
    );
    const quote = await quotePreparedUpload(prepared, {
      owner,
      sourceFileBytes: bytes.length,
    });
    return json(200, { ...prepared, quote });
  } catch (err) {
    if (isMissingEmbeddingKey(err)) {
      return json(503, {
        error: err instanceof Error ? err.message : String(err),
        code: "missing_embedding_key",
      });
    }
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes("exceeds") ? 413 : 500;
    return json(status, { error: message });
  }
}
