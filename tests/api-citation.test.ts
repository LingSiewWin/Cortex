/**
 * Tests for src/api/citation.ts — the manual "Cite" endpoint.
 *
 * Uses the deps seam (runCycle + getUserEOA) so no Braga / Cohere calls.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import type { Hex } from "@arkiv-network/sdk";
import { handleManualCitation } from "../src/api/citation";
import type { CiteCycleResult } from "../src/agent/citation-cycle";
import type { ActResult } from "../src/darwinian/citation";
import { _resetSpendGuard } from "../src/agent/spend-guard";

const EOA = ("0x" + "1".repeat(40)) as Hex;
const KEY = ("0x" + "a".repeat(64)) as Hex;

function req(body: unknown): Request {
  return new Request("http://x/api/citation/manual", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function rawReq(raw: string): Request {
  return new Request("http://x/api/citation/manual", {
    method: "POST",
    body: raw,
  });
}

function actResult(): ActResult {
  return {
    action: "manual: q",
    citations: [KEY],
    extendedKeys: [KEY],
    promotedKeys: [],
    status: "queued",
    outboxId: 7,
    citationPayloadHashHex: ("0x" + "cc".repeat(32)) as Hex,
  };
}

const okDeps = {
  getUserEOA: () => EOA,
  runCycle: async (o: { query: string }): Promise<CiteCycleResult> => ({
    query: o.query,
    hits: [
      {
        entityKey: KEY,
        entityType: "observation" as const,
        score: 1,
        expiresAtBlock: 1000,
        attributes: [],
      },
    ],
    selected: [KEY],
    act: actResult(),
  }),
};

describe("manual citation endpoint", () => {
  beforeEach(() => _resetSpendGuard());

  test("valid query → 200 with queued status + outbox id", async () => {
    const res = await handleManualCitation(req({ query: "reentrancy" }), okDeps);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      query: string;
      cited: boolean;
      status: string;
      outboxId: number;
      citationPayloadHashHex: string;
      candidateCount: number;
    };
    expect(body.query).toBe("reentrancy");
    expect(body.cited).toBe(true);
    expect(body.status).toBe("queued");
    expect(body.outboxId).toBe(7);
    expect(body.citationPayloadHashHex).toBe(("0x" + "cc".repeat(32)));
    expect(body.candidateCount).toBe(1);
  });

  test("missing query → 400", async () => {
    const res = await handleManualCitation(req({}), okDeps);
    expect(res.status).toBe(400);
  });

  test("empty query → 400", async () => {
    const res = await handleManualCitation(req({ query: "   " }), okDeps);
    expect(res.status).toBe(400);
  });

  test("non-string query → 400", async () => {
    const res = await handleManualCitation(req({ query: 42 }), okDeps);
    expect(res.status).toBe(400);
  });

  test("invalid JSON body → 400", async () => {
    const res = await handleManualCitation(rawReq("{not json"), okDeps);
    expect(res.status).toBe(400);
  });

  test("empty recall (act null) → 200 with cited:false", async () => {
    const res = await handleManualCitation(req({ query: "nothing" }), {
      getUserEOA: () => EOA,
      runCycle: async (o) => ({
        query: o.query,
        hits: [],
        selected: [],
        act: null,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cited: boolean; status: string; outboxId: number | null };
    expect(body.cited).toBe(false);
    expect(body.status).toBe("noop");
    expect(body.outboxId).toBeNull();
  });

  test("allowance error → 402", async () => {
    const res = await handleManualCitation(req({ query: "q" }), {
      getUserEOA: () => EOA,
      runCycle: async () => {
        throw new Error("agent allowance exhausted");
      },
    });
    expect(res.status).toBe(402);
  });

  test("unexpected error → 500", async () => {
    const res = await handleManualCitation(req({ query: "q" }), {
      getUserEOA: () => EOA,
      runCycle: async () => {
        throw new Error("RPC exploded");
      },
    });
    expect(res.status).toBe(500);
  });

  test("missing USER_PRIMARY_ADDRESS → 500", async () => {
    const res = await handleManualCitation(req({ query: "q" }), {
      getUserEOA: () => {
        throw new Error("USER_PRIMARY_ADDRESS missing");
      },
      runCycle: okDeps.runCycle,
    });
    expect(res.status).toBe(500);
  });
});
