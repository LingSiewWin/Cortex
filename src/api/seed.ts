/**
 * Cortex — POST /api/seed-memories.
 *
 * After the user adopts their wallet on /console, the constellation is empty
 * (their fresh wallet owns nothing). This endpoint lets the dashboard create
 * 8 demo observations sealed with the adopted wallet's key in one Arkiv tx —
 * giving the autonomous loop something to recall + cite immediately.
 *
 * Gates:
 *   - Requires a valid SIWE cookie (cortex_session).
 *   - Requires owner-identity source === "browser" (i.e. the user adopted via
 *     /api/auth/adopt). Env-only mode should use `bun run seed` CLI instead.
 *   - SIWE'd address must equal the singleton's adopted owner — prevents a
 *     different user from triggering a seed under someone else's identity.
 *
 * SIWE-session lookup is injected via setSiweSessionLookup to avoid a circular
 * import with ui-server.ts.
 */

import type { Hex } from "@arkiv-network/sdk";
import { getEffective } from "../agent/owner-identity";
import { seedDemoMemories } from "../agent/seed-memories";

export interface SiweSessionLike {
  address: Hex;
}

type SiweLookup = (cookieValue: string) => SiweSessionLike | null;

let _siweLookup: SiweLookup | null = null;

/** Wired once by ui-server.ts at module load. */
export function setSeedSiweSessionLookup(lookup: SiweLookup): void {
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

export async function handleSeedRequest(req: Request): Promise<Response> {
  const sessionId = readCookie(req, "cortex_session");
  if (!sessionId) {
    return json(401, { error: "sign in with wallet first (no SIWE session)" });
  }
  const viewer = _siweLookup ? _siweLookup(sessionId) : null;
  if (!viewer) {
    return json(401, { error: "SIWE session not found or expired" });
  }

  const view = await getEffective();
  if (view.source !== "browser" || !view.ownerAddress) {
    return json(409, {
      error:
        "no adopted wallet — connect + adopt on /console first, or use `bun run seed` for env-mode.",
    });
  }
  if (view.ownerAddress.toLowerCase() !== viewer.address.toLowerCase()) {
    return json(403, {
      error: "SIWE'd address does not match the adopted wallet",
    });
  }

  try {
    const result = await seedDemoMemories();
    return json(200, {
      txHash: result.txHash,
      entityKeys: result.entityKeys,
      count: result.count,
    });
  } catch (err) {
    return json(500, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
