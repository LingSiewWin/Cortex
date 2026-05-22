/**
 * Tests for src/agent/spend-guard.ts — the runaway-spend backstop that gates
 * the unauthenticated manual cite endpoint + the autonomous loop against a
 * shared session cap.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  checkManualAllowed,
  markManualCite,
  recordSpend,
  remainingSessionWei,
  sessionSpentTotalWei,
  configureSpendCap,
  _resetSpendGuard,
} from "../src/agent/spend-guard";

describe("spend guard", () => {
  beforeEach(() => _resetSpendGuard());

  test("first manual cite is allowed", () => {
    expect(checkManualAllowed(100n).ok).toBe(true);
  });

  test("manual cite is rate-limited right after a prior one", () => {
    markManualCite();
    const d = checkManualAllowed(100n);
    expect(d.ok).toBe(false);
    expect(d.status).toBe(429);
  });

  test("recordSpend accumulates and reduces remaining", () => {
    configureSpendCap(1000n);
    recordSpend(300n);
    expect(sessionSpentTotalWei()).toBe(300n);
    expect(remainingSessionWei()).toBe(700n);
  });

  test("exceeding the session cap is refused with 402", () => {
    configureSpendCap(1000n);
    recordSpend(950n);
    const d = checkManualAllowed(100n); // 950 + 100 > 1000
    expect(d.ok).toBe(false);
    expect(d.status).toBe(402);
  });

  test("remaining never goes negative", () => {
    configureSpendCap(100n);
    recordSpend(500n);
    expect(remainingSessionWei()).toBe(0n);
  });

  test("loop + manual spend share the same cap", () => {
    configureSpendCap(1000n);
    recordSpend(600n); // e.g. autonomous loop ticks
    recordSpend(300n); // e.g. a manual cite
    expect(remainingSessionWei()).toBe(100n);
    // Next manual cite estimated at 200 would exceed the cap.
    expect(checkManualAllowed(200n).status).toBe(402);
  });

  test("_resetSpendGuard clears state + restores default cap", () => {
    configureSpendCap(1n);
    recordSpend(5n);
    _resetSpendGuard();
    expect(sessionSpentTotalWei()).toBe(0n);
    // Default cap is large, so a normal cite is allowed again.
    expect(checkManualAllowed(100n).ok).toBe(true);
  });
});
