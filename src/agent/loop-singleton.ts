/**
 * Cortex — autonomous loop singleton + control endpoints (Phase 16).
 *
 * The dashboard server starts ONE autonomous loop in its own process so the
 * events it publishes reach the /sse stream. This module owns that handle and
 * exposes pause/resume/status for the CitationWidget's controls.
 */

import type { Hex } from "@arkiv-network/sdk";
import {
  startAutonomousLoop,
  DEFAULT_QUERY_POOL,
  type AutonomousLoopHandle,
} from "./autonomous-loop";
import { getUserPrimaryEOA } from "../lib/arkiv-client";

let handle: AutonomousLoopHandle | null = null;

/**
 * Start the singleton loop if not already running. Returns the handle, or null
 * when the environment isn't configured for writes (no USER_PRIMARY_ADDRESS).
 * Idempotent — repeated calls return the existing handle.
 */
export function startSingletonLoop(overrides?: {
  cadenceMs?: number;
  queryPool?: string[];
}): AutonomousLoopHandle | null {
  if (handle) return handle;
  let userPrimaryEOA: Hex;
  try {
    userPrimaryEOA = getUserPrimaryEOA();
  } catch {
    // No wallet configured — server still serves the read-only dashboard.
    return null;
  }
  handle = startAutonomousLoop({
    queryPool: overrides?.queryPool ?? DEFAULT_QUERY_POOL,
    userPrimaryEOA,
    cadenceMs: overrides?.cadenceMs ?? 20_000,
  });
  return handle;
}

export function getLoopHandle(): AutonomousLoopHandle | null {
  return handle;
}

/** Test seam — drop the singleton so a fresh loop can be started. */
export function _resetLoopSingleton(): void {
  if (handle) handle.stop();
  handle = null;
}

// ---------------------------------------------------------------------------
// Control endpoints
// ---------------------------------------------------------------------------

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** GET /api/loop/status → { running, paused } */
export function handleLoopStatus(): Response {
  if (!handle) return json(200, { running: false, paused: false, configured: false });
  return json(200, {
    running: !handle.isStopped() && !handle.isPaused(),
    paused: handle.isPaused(),
    configured: true,
  });
}

/** POST /api/loop/control { action: "pause" | "resume" } */
export async function handleLoopControl(req: Request): Promise<Response> {
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 1024) {
    return json(413, { error: "request body too large" });
  }
  let body: { action?: unknown } | null;
  try {
    body = (await req.json()) as { action?: unknown };
  } catch {
    return json(400, { error: "invalid JSON body" });
  }
  const action = body?.action;
  if (action !== "pause" && action !== "resume") {
    return json(400, { error: 'action must be "pause" or "resume"' });
  }
  if (!handle) {
    return json(409, { error: "autonomous loop not running (no wallet configured)" });
  }
  if (action === "pause") handle.pause();
  else handle.resume();
  return json(200, { running: !handle.isStopped() && !handle.isPaused(), paused: handle.isPaused() });
}
