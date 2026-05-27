/**
 * Cortex — /api/auth/adopt and /api/auth/me.
 *
 * The browser side of "adopt my connected wallet as the agent's owner". The
 * client signs keyDerivationMessage(addr) once after the existing SIWE
 * handshake and POSTs the signature here; we verify it recovers to the
 * SIWE'd address, install the wallet-derived AES key in the singleton, and
 * (re)start the autonomous loop if it was dormant.
 *
 * /api/auth/me is a read-only echo so the dashboard knows which owner to
 * scope its data calls to.
 *
 * The SIWE-session lookup is injected via `setSiweSessionLookup` to avoid a
 * circular import between this module and ui-server.ts (which routes here).
 */
import type { Hex } from "@arkiv-network/sdk";
import { adopt, getEffective } from "../agent/owner-identity";
import { _resetPayloadKey } from "../lib/payload-key";
import { startSingletonLoop } from "../agent/loop-singleton";
import { hasEmbeddingKey } from "../compression/embeddings";
import { readConfig } from "../lib/cortex-config";

export interface SiweSessionLike {
  address: Hex;
}

type SiweLookup = (cookieValue: string) => SiweSessionLike | null;

let _siweLookup: SiweLookup | null = null;

/** Wired once by ui-server.ts at module load. */
export function setSiweSessionLookup(lookup: SiweLookup): void {
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

interface AdoptBody {
  address?: string;
  signature?: string;
}

export async function handleAdoptRequest(req: Request): Promise<Response> {
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 4096) {
    return json(413, { error: "request body too large" });
  }

  let body: AdoptBody | null;
  try {
    body = (await req.json()) as AdoptBody;
  } catch {
    return json(400, { error: "invalid JSON body" });
  }

  const address = body?.address;
  const signature = body?.signature;
  if (typeof address !== "string" || typeof signature !== "string") {
    return json(400, { error: "address and signature required" });
  }

  // When a SIWE session exists, it must match the adopting address. Wallet-only
  // adoption (official MetaMask sketch flow) skips SIWE — the derivation signature
  // is verified inside adopt().
  const sessionId = readCookie(req, "cortex_session");
  if (sessionId) {
    const viewer = _siweLookup ? _siweLookup(sessionId) : null;
    if (viewer && viewer.address.toLowerCase() !== address.toLowerCase()) {
      return json(400, { error: "adopt address does not match SIWE session" });
    }
  }

  let view;
  try {
    view = await adopt({ address: address as Hex, signature: signature as Hex });
  } catch (err) {
    return json(401, { error: err instanceof Error ? err.message : "adopt failed" });
  }

  // Bust the legacy payload-key memo so cached env-derived keys can't leak.
  _resetPayloadKey();

  // If the loop was dormant (no env owner), start it now. Failures here don't
  // fail the adopt — identity is swapped; the loop will retry on next status poll.
  try {
    startSingletonLoop();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[cortex/auth-adopt] loop start failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return json(200, {
    ownerAddress: view.ownerAddress,
    source: view.source,
  });
}

export async function handleAuthMe(_req: Request): Promise<Response> {
  const view = await getEffective();
  const uploadBlockers: string[] = [];
  const agentBlockers: string[] = [];

  if (!hasEmbeddingKey()) {
    uploadBlockers.push(
      "Server embedding key missing — set OPENAI_API_KEY (or OPENROUTER / VOYAGE / COHERE).",
    );
  }
  if (!(process.env.SESSION_KEY_PRIVATE_KEY ?? readConfig()?.sessionKeyPrivate)) {
    agentBlockers.push(
      "Autonomous agent relayer: run `bun run cortex-auth` or set SESSION_KEY_PRIVATE_KEY.",
    );
  }

  return json(200, {
    ownerAddress: view.ownerAddress,
    source: view.source,
    uploadReady: uploadBlockers.length === 0,
    uploadBlockers,
    agentBlockers,
    browserUpload: true,
  });
}
