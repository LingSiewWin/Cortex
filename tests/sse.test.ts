/**
 * Tests for src/api/sse.ts — the SSE bridge over the event bus.
 *
 * We verify the pure helpers (parseTypes, formatFrame) exhaustively and the
 * stream handler's observable contract: correct headers, retry hint, replay
 * of buffered events newer than Last-Event-ID, and live delivery.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import type { Hex } from "@arkiv-network/sdk";
import { handleSSE, parseTypes, formatFrame, _resetSseConnections } from "../src/api/sse";
import {
  publish,
  _resetBus,
  ALL_EVENT_TYPES,
  type BufferedEvent,
  type DomainEvent,
} from "../src/lib/events";

function rpcEvent(): DomainEvent {
  return {
    type: "arkiv.rpc.call",
    ts: Date.now(),
    method: "getEntity",
    byteSize: 128,
    ms: 5,
    ok: true,
  };
}

/**
 * Drain the stream until `expectedFrames` `id:` frames have been read, then
 * cancel. start() enqueues retry + all replay frames synchronously, so each
 * buffered chunk is drained without blocking; we stop before the live-wait.
 * `maxReads` is a safety cap so a wrong expectation can't hang the test.
 */
async function readFrames(
  res: Response,
  expectedFrames: number,
  maxReads = 30,
): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (let i = 0; i < maxReads; i++) {
    if ((out.match(/^id: /gm) ?? []).length >= expectedFrames) break;
    const { value, done } = await reader.read();
    if (done) break;
    if (value) out += dec.decode(value, { stream: true });
  }
  await reader.cancel();
  return out;
}

function countFrames(text: string): number {
  return (text.match(/^id: /gm) ?? []).length;
}

describe("sse — parseTypes", () => {
  test("missing param returns all types", () => {
    expect(parseTypes(null)).toEqual(ALL_EVENT_TYPES);
  });

  test("'all' returns all types", () => {
    expect(parseTypes("all")).toEqual(ALL_EVENT_TYPES);
  });

  test("comma list returns only recognised types", () => {
    expect(parseTypes("arkiv.rpc.call,rabitq.encoded")).toEqual([
      "arkiv.rpc.call",
      "rabitq.encoded",
    ]);
  });

  test("unknown types are dropped", () => {
    expect(parseTypes("arkiv.rpc.call,bogus.type")).toEqual([
      "arkiv.rpc.call",
    ]);
  });

  test("only-unknown falls back to all (never an empty stream)", () => {
    expect(parseTypes("bogus.type")).toEqual(ALL_EVENT_TYPES);
  });

  test("whitespace is trimmed", () => {
    expect(parseTypes(" arkiv.rpc.call , rabitq.encoded ")).toEqual([
      "arkiv.rpc.call",
      "rabitq.encoded",
    ]);
  });
});

describe("sse — formatFrame", () => {
  test("produces id/event/data frame ending in blank line", () => {
    const envelope: BufferedEvent = {
      id: "7",
      type: "arkiv.rpc.call",
      event: rpcEvent(),
    };
    const frame = formatFrame(envelope);
    expect(frame.startsWith("id: 7\n")).toBe(true);
    expect(frame).toContain("event: arkiv.rpc.call\n");
    expect(frame).toContain("data: {");
    expect(frame.endsWith("\n\n")).toBe(true);
  });
});

describe("sse — handleSSE stream", () => {
  beforeEach(() => {
    _resetBus();
    _resetSseConnections();
  });

  test("returns text/event-stream with no-cache + anti-buffering headers", async () => {
    const res = handleSSE(new Request("http://x/sse"));
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toContain("no-cache");
    expect(res.headers.get("X-Accel-Buffering")).toBe("no");
    await res.body!.cancel();
  });

  test("emits retry hint then replays buffered events", async () => {
    publish(rpcEvent());
    publish(rpcEvent());
    const res = handleSSE(new Request("http://x/sse?types=arkiv.rpc.call"));
    const text = await readFrames(res, 2);
    expect(text).toContain("retry: 3000");
    expect(countFrames(text)).toBe(2);
    expect(text).toContain("event: arkiv.rpc.call");
  });

  test("Last-Event-ID replays only newer events", async () => {
    const first = publish(rpcEvent());
    publish(rpcEvent());
    publish(rpcEvent());
    const res = handleSSE(
      new Request("http://x/sse?types=arkiv.rpc.call", {
        headers: { "Last-Event-ID": first.id },
      }),
    );
    const text = await readFrames(res, 2);
    // first.id filtered out → 2 newer events replayed.
    expect(countFrames(text)).toBe(2);
  });

  test("live event published after connect is delivered", async () => {
    const res = handleSSE(new Request("http://x/sse?types=arkiv.rpc.call"));
    // No buffered events; publish one after the stream is open.
    publish(rpcEvent());
    const text = await readFrames(res, 1);
    expect(countFrames(text)).toBe(1);
  });

  test("refuses connections past the per-IP cap with 429", async () => {
    const server = {
      timeout: () => {},
      requestIP: () => ({ address: "1.2.3.4" }),
    };
    const open: Response[] = [];
    // Per-IP cap is 6 — open 6, then the 7th must be refused.
    for (let i = 0; i < 6; i++) {
      const r = handleSSE(new Request("http://x/sse"), server);
      expect(r.status).toBe(200);
      open.push(r);
    }
    const refused = handleSSE(new Request("http://x/sse"), server);
    expect(refused.status).toBe(429);
    // Closing one frees a slot.
    await open[0]!.body!.cancel();
    const allowedAgain = handleSSE(new Request("http://x/sse"), server);
    expect(allowedAgain.status).toBe(200);
    await allowedAgain.body!.cancel();
    for (let i = 1; i < open.length; i++) await open[i]!.body!.cancel();
  });

  test("server.timeout(req,0) is invoked when server provided", () => {
    const calls: number[] = [];
    const fakeServer = {
      timeout: (_req: Request, seconds: number) => {
        calls.push(seconds);
      },
    };
    const res = handleSSE(new Request("http://x/sse"), fakeServer);
    expect(calls).toEqual([0]);
    void res.body!.cancel();
  });
});
