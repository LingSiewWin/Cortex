/**
 * Tests for src/darwinian/utility.ts — the SEDM-fusion utility math.
 * Verifies the proxy Û, weight evolution (incl. anti-spam), lease scaling
 * (monotone + bounded + never below base), and recall fusion clamp.
 */

import { describe, test, expect } from "bun:test";
import {
  proxyUtility,
  evolveWeight,
  leaseSeconds,
  recallWeightFactor,
} from "../src/darwinian/utility";
import { UTILITY, REINFORCEMENT } from "../src/constants";

const HOUR = 60 * 60 * 1000;

describe("proxyUtility", () => {
  test("output is always in [0,1]", () => {
    const u = proxyUtility({ msSinceLastCite: 0, citationCount: 1, rank: 0, k: 5, outcome: 1 });
    expect(u).toBeGreaterThanOrEqual(0);
    expect(u).toBeLessThanOrEqual(1);
  });

  test("first-ever cite has zero recency contribution (dt = Infinity)", () => {
    const first = proxyUtility({ msSinceLastCite: Infinity, citationCount: 1, rank: 0, k: 5, outcome: 0.5 });
    const recent = proxyUtility({ msSinceLastCite: 0, citationCount: 1, rank: 0, k: 5, outcome: 0.5 });
    // recent gets the full recency weight; first gets none → recent strictly higher.
    expect(recent).toBeGreaterThan(first);
    expect(recent - first).toBeCloseTo(UTILITY.sigRecency, 5);
  });

  test("recency decays with time since last cite", () => {
    const now = proxyUtility({ msSinceLastCite: 0, citationCount: 1, rank: 0, k: 5 });
    const old = proxyUtility({ msSinceLastCite: 12 * HOUR, citationCount: 1, rank: 0, k: 5 });
    expect(now).toBeGreaterThan(old);
  });

  test("co-citation precision: citing fewer memories credits each more", () => {
    const solo = proxyUtility({ msSinceLastCite: 0, citationCount: 1, rank: 0, k: 5 });
    const spread = proxyUtility({ msSinceLastCite: 0, citationCount: 8, rank: 0, k: 5 });
    expect(solo).toBeGreaterThan(spread);
  });

  test("rank quality: top-ranked memory scores higher than bottom", () => {
    const top = proxyUtility({ msSinceLastCite: 0, citationCount: 1, rank: 0, k: 5 });
    const bottom = proxyUtility({ msSinceLastCite: 0, citationCount: 1, rank: 4, k: 5 });
    expect(top).toBeGreaterThan(bottom);
  });

  test("outcome signal moves the score", () => {
    const good = proxyUtility({ msSinceLastCite: 0, citationCount: 1, rank: 0, k: 5, outcome: 1 });
    const bad = proxyUtility({ msSinceLastCite: 0, citationCount: 1, rank: 0, k: 5, outcome: 0 });
    expect(good - bad).toBeCloseTo(UTILITY.sigOutcome, 5);
  });
});

describe("evolveWeight", () => {
  test("high utility raises weight", () => {
    expect(evolveWeight(1.0, 1.0, 1)).toBeGreaterThan(1.0);
  });

  test("anti-spam: high usage + low utility LOWERS weight (w ≠ citation count)", () => {
    // A memory cited repeatedly (fUse high) but with weak proxy utility must decay.
    let w = 2.0;
    for (let i = 0; i < 10; i++) w = evolveWeight(w, 0.05, 3); // low Û, repeated heavy use
    expect(w).toBeLessThan(2.0);
  });

  test("clamps to [0, wMax]", () => {
    expect(evolveWeight(UTILITY.wMax, 1.0, 0)).toBe(UTILITY.wMax);
    expect(evolveWeight(0, 0, 100)).toBe(0);
  });

  test("non-finite prior falls back to wInit baseline", () => {
    const w = evolveWeight(Number.NaN, 0.5, 1);
    const expected = Math.min(
      UTILITY.wMax,
      Math.max(0, UTILITY.wInit + UTILITY.alpha * 0.5 - UTILITY.beta * 1),
    );
    expect(w).toBeCloseTo(expected, 5);
  });
});

describe("leaseSeconds", () => {
  const base = REINFORCEMENT.workingReinforcementSeconds;

  test("always >= base (lease never shrinks — Arkiv extend is monotone)", () => {
    expect(leaseSeconds(base, 0)).toBe(base);
    expect(leaseSeconds(base, -5)).toBe(base); // clamped
  });

  test("monotone increasing in weight", () => {
    expect(leaseSeconds(base, 2)).toBeGreaterThan(leaseSeconds(base, 1));
  });

  test("bounded by base·(1+gamma·wMax) — no fee runaway", () => {
    const max = leaseSeconds(base, 999);
    expect(max).toBe(Math.round(base * (1 + UTILITY.gamma * UTILITY.wMax)));
  });
});

describe("recallWeightFactor", () => {
  test("clamps to [wMin, wMax]", () => {
    expect(recallWeightFactor(0)).toBe(UTILITY.wMin);
    expect(recallWeightFactor(999)).toBe(UTILITY.wMax);
    expect(recallWeightFactor(1.0)).toBe(1.0);
  });

  test("cold-start (wInit) is recall-visible (>= wMin)", () => {
    expect(recallWeightFactor(UTILITY.wInit)).toBeGreaterThanOrEqual(UTILITY.wMin);
  });
});
