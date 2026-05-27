/**
 * Cortex — session-summary input validation.
 *
 * The storage path itself reuses createDocumentMemory (Braga-verified in the
 * Document-Tier e2e), so here we lock the guard rails that protect it: a session
 * summary must have non-empty summary text and a sessionId. The full
 * embed→seal→Arkiv→recall round-trip is covered by the live Braga proof.
 */

import { test, expect } from "bun:test";
import { storeSessionSummary } from "../src/agent/session-summary.ts";

test("rejects empty summary", async () => {
  await expect(
    storeSessionSummary({ summary: "   ", sessionId: "s1" }),
  ).rejects.toThrow(/summary must be a non-empty string/);
});

test("rejects missing sessionId", async () => {
  await expect(
    storeSessionSummary({ summary: "did real work", sessionId: "" }),
  ).rejects.toThrow(/sessionId is required/);
});
