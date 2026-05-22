/**
 * Cortex — Live Spine end-to-end (in-process).
 *
 * Proves the contract: events published on the bus are delivered, in order,
 * to an SSE client subscribed to the stream. This is the integration seam
 * between the instrumented code paths and the dashboard.
 *
 * (The REAL events firing from real Braga operations are proven separately by
 * scripts/spine-check.ts; the loop orchestration by tests/autonomous-loop.test.ts.
 * This test isolates the bus → SSE delivery + ordering.)
 */

import { describe, test, expect, beforeEach } from "bun:test";
import type { Hex } from "@arkiv-network/sdk";
import { handleSSE, _resetSseConnections } from "../src/api/sse";
import { publish, _resetBus, type DomainEvent } from "../src/lib/events";

const KEY = ("0x" + "a".repeat(64)) as Hex;
const ROOT = ("0x" + "b".repeat(64)) as Hex;

/** The canonical cascade a single autonomous tick produces. */
const CASCADE: DomainEvent[] = [
  { type: "agent.loop.tick", ts: 1, query: "q", queuedAt: 1 },
  { type: "rabitq.encoded", ts: 2, dim: 1536, bytes: 198, ratio: 31, ms: 4 },
  { type: "recall.completed", ts: 3, query: "q", candidateIds: [KEY], selectedId: KEY },
  { type: "memory.created", ts: 4, entityKey: KEY, tier: "working", expiresAtBlock: 0 },
  { type: "memory.cited", ts: 5, entityKey: KEY, reinforcementSeconds: 86400 },
  { type: "mmr.appended", ts: 6, leafIndex: 0, leafHash: KEY, newRoot: ROOT, leafCount: 1 },
  { type: "anchor.committed", ts: 7, rootHex: ROOT, leafCount: 1, txHash: "0xtx" },
  { type: "allowance.spent", ts: 8, wei: "100", remainingWei: "900", runwaySeconds: 180 },
];

async function readFrames(res: Response, expected: number, maxReads = 40): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (let i = 0; i < maxReads; i++) {
    if ((out.match(/^id: /gm) ?? []).length >= expected) break;
    const { value, done } = await reader.read();
    if (done) break;
    if (value) out += dec.decode(value, { stream: true });
  }
  await reader.cancel();
  return out;
}

describe("spine e2e — bus → SSE delivery", () => {
  beforeEach(() => {
    _resetBus();
    _resetSseConnections();
  });

  test("a full cascade is delivered to an SSE client in order", async () => {
    const res = handleSSE(new Request("http://x/sse?types=all"));
    // Publish the cascade after the stream is open (live path).
    for (const e of CASCADE) publish(e);

    const text = await readFrames(res, CASCADE.length);

    // Extract event types in delivery order.
    const delivered = (text.match(/^event: (.+)$/gm) ?? []).map((l) =>
      l.replace("event: ", ""),
    );
    expect(delivered).toEqual(CASCADE.map((e) => e.type));
  });

  test("a reconnecting client replays the cascade via Last-Event-ID=0", async () => {
    // Publish BEFORE connecting — exercises the ring-buffer replay path.
    for (const e of CASCADE) publish(e);
    const res = handleSSE(new Request("http://x/sse?types=all"));
    const text = await readFrames(res, CASCADE.length);
    const delivered = (text.match(/^event: (.+)$/gm) ?? []).map((l) =>
      l.replace("event: ", ""),
    );
    expect(delivered).toEqual(CASCADE.map((e) => e.type));
  });

  test("type-filtered client only receives its subset, still ordered", async () => {
    const res = handleSSE(
      new Request("http://x/sse?types=memory.cited,anchor.committed"),
    );
    for (const e of CASCADE) publish(e);
    const text = await readFrames(res, 2);
    const delivered = (text.match(/^event: (.+)$/gm) ?? []).map((l) =>
      l.replace("event: ", ""),
    );
    expect(delivered).toEqual(["memory.cited", "anchor.committed"]);
  });
});
