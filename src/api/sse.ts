/**
 * Cortex — Server-Sent Events bridge (Phase 16).
 *
 * Bridges the in-process event bus (src/lib/events.ts) to browser clients
 * over a single long-lived `text/event-stream` connection.
 *
 * Wire format (one frame per event):
 *   id: <seq>\n
 *   event: <type>\n
 *   data: <json>\n\n
 *
 * Reconnect semantics:
 *   - Server sends `retry: 3000` on connect → browser reconnects after 3s.
 *   - Browser auto-sends `Last-Event-ID` on reconnect → we replay only events
 *     newer than that id from the bus ring buffer, so a reload isn't blank and
 *     a brief disconnect doesn't drop events.
 *
 * Bun specifics (research-grounded):
 *   - `server.timeout(req, 0)` disables the default 10s idle kill for this
 *     long-lived request. Without it the stream dies after 10s of silence.
 *   - `X-Accel-Buffering: no` + `no-transform` stop reverse proxies buffering
 *     the stream into oblivion.
 *   - A 15s keepalive comment frame (`: ping`) keeps intermediaries from
 *     closing an idle connection and surfaces dead sockets to `cancel()`.
 */

import {
  replay,
  subscribe,
  ALL_EVENT_TYPES,
  type DomainEventType,
  type BufferedEvent,
} from "../lib/events";

/** Minimal shape of the Bun server we need — keeps this unit-testable. */
export interface SseServerLike {
  timeout(req: Request, seconds: number): void;
  requestIP?(req: Request): { address: string } | null;
}

const ALL_TYPES_SET = new Set<string>(ALL_EVENT_TYPES);

// Connection caps — bound fan-out cost + file descriptors against an attacker
// opening thousands of /sse sockets (DoS of the dashboard).
const MAX_CONNECTIONS = 100;
const MAX_CONNECTIONS_PER_IP = 6;
let activeConnections = 0;
const connectionsByIp = new Map<string, number>();

function incConn(ip: string): void {
  activeConnections += 1;
  connectionsByIp.set(ip, (connectionsByIp.get(ip) ?? 0) + 1);
}
function decConn(ip: string): void {
  activeConnections = Math.max(0, activeConnections - 1);
  const n = (connectionsByIp.get(ip) ?? 1) - 1;
  if (n <= 0) connectionsByIp.delete(ip);
  else connectionsByIp.set(ip, n);
}

/** Test seam — reset connection counters. */
export function _resetSseConnections(): void {
  activeConnections = 0;
  connectionsByIp.clear();
}

/**
 * Parse the `?types=` query param into a validated list of event types.
 * - missing / "all" → every known type
 * - comma-separated list → only the recognised ones (unknown silently dropped)
 */
export function parseTypes(param: string | null): DomainEventType[] {
  if (!param || param === "all") return [...ALL_EVENT_TYPES];
  const requested = param
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const valid = requested.filter((t) => ALL_TYPES_SET.has(t)) as DomainEventType[];
  // If the caller asked only for unknown types, fall back to all rather than
  // opening a stream that can never emit anything.
  return valid.length > 0 ? valid : [...ALL_EVENT_TYPES];
}

/**
 * Serialise a buffered event into an SSE frame.
 * Exported for tests.
 */
export function formatFrame(e: BufferedEvent): string {
  return `id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e.event)}\n\n`;
}

/**
 * Build the SSE Response. `server` is optional so tests can call this without
 * a live Bun server (the idle-timeout disable is a no-op in that case).
 */
export function handleSSE(req: Request, server?: SseServerLike): Response {
  const ip = server?.requestIP?.(req)?.address ?? "unknown";

  // Refuse beyond the global / per-IP connection caps (DoS guard).
  if (
    activeConnections >= MAX_CONNECTIONS ||
    (connectionsByIp.get(ip) ?? 0) >= MAX_CONNECTIONS_PER_IP
  ) {
    return new Response("too many SSE connections", {
      status: 429,
      headers: { "retry-after": "5" },
    });
  }

  server?.timeout(req, 0);

  const url = new URL(req.url);
  const types = parseTypes(url.searchParams.get("types"));
  const typeSet = new Set<DomainEventType>(types);
  const lastId = req.headers.get("Last-Event-ID");

  let unsub: (() => void) | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;
  let counted = false;
  const enc = new TextEncoder();

  incConn(ip);
  counted = true;
  const releaseConn = () => {
    if (counted) {
      counted = false;
      decConn(ip);
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const safeEnqueue = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(text));
        } catch {
          // Controller already closed (client vanished mid-write). Mark closed
          // and tear down — cancel() may or may not fire depending on timing.
          closed = true;
          if (unsub) unsub();
          if (ping) clearInterval(ping);
          releaseConn();
        }
      };

      // 1. Reconnect backoff hint.
      safeEnqueue("retry: 3000\n\n");
      // 2. Replay buffered events newer than Last-Event-ID (snapshot on reload).
      for (const e of replay(types, lastId)) safeEnqueue(formatFrame(e));
      // 3. Live subscription, filtered to the requested types.
      unsub = subscribe((e) => {
        if (typeSet.has(e.type)) safeEnqueue(formatFrame(e));
      });
      // 4. Keepalive.
      ping = setInterval(() => safeEnqueue(": ping\n\n"), 15_000);
    },
    cancel() {
      if (unsub) unsub();
      if (ping) clearInterval(ping);
      releaseConn();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
