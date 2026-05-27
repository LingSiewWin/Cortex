import { test, expect, mock } from "bun:test";
import type { Hex } from "@arkiv-network/sdk";

test("POST /api/memories/register hydrates mirror and emits memory.created", async () => {
  const entityKey = ("0x" + "ab".repeat(32)) as Hex;
  const published: unknown[] = [];

  mock.module("../src/mirror/hydrate-one.ts", () => ({
    hydrateEntityFromChain: async () => ({
      status: "ok" as const,
      entityKey,
      entityType: "document",
      expiresAtBlock: 999_000,
    }),
  }));

  mock.module("../src/lib/events.ts", () => ({
    publish: (e: unknown) => {
      published.push(e);
    },
  }));

  const { handleMemoryRegisterRequest } = await import("../src/api/memory-register.ts");
  const res = await handleMemoryRegisterRequest(
    new Request("http://localhost/api/memories/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entityKey, txHash: "0xdead" }),
    }),
  );

  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; entityKey: string };
  expect(body.ok).toBe(true);
  expect(body.entityKey).toBe(entityKey);
  expect(published.length).toBe(1);
  expect((published[0] as { type: string }).type).toBe("memory.created");
});
