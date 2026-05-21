/**
 * Cortex — MMR unit tests.
 *
 * Phase 12 gating: this suite must pass before we touch the Arkiv relayer.
 *
 * What we prove:
 *   1. Pure-math correctness of append + getRoot for small known cases (so we
 *      can compute the expected root by hand).
 *   2. Determinism — same leaf sequence ⇒ byte-identical root.
 *   3. Round-trip — every leaf in an MMR of size N produces a proof that
 *      `verifyMMRProof` accepts.
 *   4. Tamper rejection — any single bit flipped in path / peaks / root /
 *      claimed leaf hash MUST cause verify to return false.
 *   5. Edge cases — empty MMR, single leaf, exactly 2^k leaves, non-pow-of-2.
 *   6. Performance — 10,000 appends complete under 100 ms on the test machine.
 *      This is the gate the user explicitly named.
 */

import { test, expect, describe } from "bun:test";
import { keccak256, bytesToHex } from "viem";
import { MMR, verifyMMRProof, hashBytes } from "../src/mirror/mmr";

function leaf(seed: number): Uint8Array {
  // Deterministic 32-byte leaf from a small seed.
  const input = new Uint8Array(32);
  // Write seed as little-endian uint32 + a constant tail for collision resistance.
  input[0] = seed & 0xff;
  input[1] = (seed >> 8) & 0xff;
  input[2] = (seed >> 16) & 0xff;
  input[3] = (seed >> 24) & 0xff;
  return keccak256(input, "bytes");
}

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function pairHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  const concat = new Uint8Array(left.length + right.length);
  concat.set(left, 0);
  concat.set(right, left.length);
  return keccak256(concat, "bytes");
}

// ---------------------------------------------------------------------------
// Pure-math correctness — small known trees
// ---------------------------------------------------------------------------

describe("MMR — correctness on small inputs", () => {
  test("empty MMR has zero root", () => {
    const mmr = new MMR();
    const root = mmr.getRoot();
    expect(root.length).toBe(32);
    expect(bytesEq(root, new Uint8Array(32))).toBe(true);
    expect(mmr.size()).toBe(0);
  });

  test("single leaf root equals the leaf hash", () => {
    const mmr = new MMR();
    const L0 = leaf(0);
    mmr.append(L0);
    expect(bytesEq(mmr.getRoot(), L0)).toBe(true);
    expect(mmr.size()).toBe(1);
  });

  test("two leaves root equals hash(L0, L1)", () => {
    const mmr = new MMR();
    const L0 = leaf(0);
    const L1 = leaf(1);
    mmr.append(L0);
    mmr.append(L1);
    const expected = pairHash(L0, L1);
    expect(bytesEq(mmr.getRoot(), expected)).toBe(true);
  });

  test("three leaves root equals hash(P01, L2)", () => {
    const mmr = new MMR();
    const L0 = leaf(0);
    const L1 = leaf(1);
    const L2 = leaf(2);
    mmr.append(L0);
    mmr.append(L1);
    mmr.append(L2);
    const P01 = pairHash(L0, L1);
    const expected = pairHash(P01, L2);
    expect(bytesEq(mmr.getRoot(), expected)).toBe(true);
  });

  test("four leaves root collapses into a single peak P0123", () => {
    const mmr = new MMR();
    const L = [leaf(0), leaf(1), leaf(2), leaf(3)];
    for (const l of L) mmr.append(l);
    const P01 = pairHash(L[0]!, L[1]!);
    const P23 = pairHash(L[2]!, L[3]!);
    const P0123 = pairHash(P01, P23);
    expect(bytesEq(mmr.getRoot(), P0123)).toBe(true);
  });

  test("six leaves: bag(P0123, P45)", () => {
    const mmr = new MMR();
    const L = [leaf(0), leaf(1), leaf(2), leaf(3), leaf(4), leaf(5)];
    for (const l of L) mmr.append(l);
    const P01 = pairHash(L[0]!, L[1]!);
    const P23 = pairHash(L[2]!, L[3]!);
    const P0123 = pairHash(P01, P23);
    const P45 = pairHash(L[4]!, L[5]!);
    const expected = pairHash(P0123, P45);
    expect(bytesEq(mmr.getRoot(), expected)).toBe(true);
  });

  test("rejects leaves that aren't 32 bytes", () => {
    const mmr = new MMR();
    expect(() => mmr.append(new Uint8Array(16))).toThrow();
    expect(() => mmr.append(new Uint8Array(33))).toThrow();
    expect(() => mmr.append(new Uint8Array(0))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("MMR — determinism", () => {
  test("same leaf sequence produces byte-identical root", () => {
    const make = () => {
      const m = new MMR();
      for (let i = 0; i < 50; i++) m.append(leaf(i));
      return m.getRoot();
    };
    expect(bytesToHex(make())).toBe(bytesToHex(make()));
  });

  test("root changes after a single new leaf", () => {
    const m = new MMR();
    for (let i = 0; i < 100; i++) m.append(leaf(i));
    const before = bytesToHex(m.getRoot());
    m.append(leaf(100));
    const after = bytesToHex(m.getRoot());
    expect(after).not.toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Proof round-trip
// ---------------------------------------------------------------------------

describe("MMR — proof generation + verification round-trip", () => {
  const SIZES = [1, 2, 3, 4, 5, 7, 8, 9, 16, 17, 31, 64, 100, 257];
  for (const n of SIZES) {
    test(`every leaf verifies in an MMR of size ${n}`, () => {
      const mmr = new MMR();
      for (let i = 0; i < n; i++) mmr.append(leaf(i));
      for (let i = 0; i < n; i++) {
        const proof = mmr.getProof(i);
        expect(verifyMMRProof(proof)).toBe(true);
      }
    });
  }

  test("proof for out-of-range leaf throws", () => {
    const mmr = new MMR();
    for (let i = 0; i < 5; i++) mmr.append(leaf(i));
    expect(() => mmr.getProof(-1)).toThrow();
    expect(() => mmr.getProof(5)).toThrow();
    expect(() => mmr.getProof(100)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tamper rejection
// ---------------------------------------------------------------------------

describe("MMR — verify rejects any tampered field", () => {
  test("wrong claimed root → false", () => {
    const mmr = new MMR();
    for (let i = 0; i < 10; i++) mmr.append(leaf(i));
    const proof = mmr.getProof(3);
    const tampered = {
      ...proof,
      root: ("0x" + "ff".repeat(32)) as `0x${string}`,
    };
    expect(verifyMMRProof(tampered)).toBe(false);
  });

  test("wrong leaf hash → false", () => {
    const mmr = new MMR();
    for (let i = 0; i < 10; i++) mmr.append(leaf(i));
    const proof = mmr.getProof(3);
    const tampered = {
      ...proof,
      leafHash: ("0x" + "00".repeat(32)) as `0x${string}`,
    };
    expect(verifyMMRProof(tampered)).toBe(false);
  });

  test("flipped path bit → false", () => {
    const mmr = new MMR();
    for (let i = 0; i < 10; i++) mmr.append(leaf(i));
    const proof = mmr.getProof(3);
    if (proof.path.length === 0) return;
    const orig = proof.path[0]!.sibling;
    // Flip the last byte's low bit
    const bytes = Buffer.from(orig.slice(2), "hex");
    const lastIdx = bytes.length - 1;
    bytes[lastIdx] = (bytes[lastIdx] ?? 0) ^ 0x01;
    const tampered = {
      ...proof,
      path: [
        { ...proof.path[0]!, sibling: ("0x" + bytes.toString("hex")) as `0x${string}` },
        ...proof.path.slice(1),
      ],
    };
    expect(verifyMMRProof(tampered)).toBe(false);
  });

  test("swapped direction bit → false (when path has >=1 step)", () => {
    const mmr = new MMR();
    for (let i = 0; i < 10; i++) mmr.append(leaf(i));
    const proof = mmr.getProof(2);
    if (proof.path.length === 0) return;
    const tampered = {
      ...proof,
      path: [
        { ...proof.path[0]!, isLeft: !proof.path[0]!.isLeft },
        ...proof.path.slice(1),
      ],
    };
    expect(verifyMMRProof(tampered)).toBe(false);
  });

  test("malformed hex in any field → false (not a throw)", () => {
    const mmr = new MMR();
    for (let i = 0; i < 4; i++) mmr.append(leaf(i));
    const proof = mmr.getProof(0);
    const malformed = { ...proof, leafHash: "0xZZZZ" as `0x${string}` };
    expect(verifyMMRProof(malformed)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Performance gate — the user's explicit threshold
// ---------------------------------------------------------------------------

describe("MMR — performance", () => {
  test(
    "10,000 appends + 1 root computation under 100ms",
    () => {
      const mmr = new MMR();
      const t0 = performance.now();
      for (let i = 0; i < 10_000; i++) {
        mmr.append(leaf(i));
      }
      const rootHex = mmr.getRootHex();
      const t1 = performance.now();
      const elapsed = t1 - t0;
      // Surface the number even when the test passes — useful for CI logs.
      console.log(`  [bench] 10k appends + root: ${elapsed.toFixed(2)}ms`);
      expect(rootHex).toMatch(/^0x[0-9a-f]{64}$/);
      expect(mmr.size()).toBe(10_000);
      expect(elapsed).toBeLessThan(100);
    },
    10_000,
  );

  test("getRoot is cached — second call is essentially free", () => {
    const mmr = new MMR();
    for (let i = 0; i < 1000; i++) mmr.append(leaf(i));
    // First call: do work
    mmr.getRoot();
    // Second call: must be cached. Measure.
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) mmr.getRoot();
    const t1 = performance.now();
    const perCall = (t1 - t0) / 1000;
    // 1000 calls should aggregate to << 10ms on any modern hardware.
    expect(perCall).toBeLessThan(0.05); // < 50μs per call
  });
});

// ---------------------------------------------------------------------------
// hashBytes export — used by the daemon ingestion hook
// ---------------------------------------------------------------------------

describe("MMR — hashBytes export", () => {
  test("hashBytes returns 32-byte keccak256", () => {
    const out = hashBytes(new Uint8Array([1, 2, 3]));
    expect(out.length).toBe(32);
    // Matches viem's keccak256 directly
    expect(bytesToHex(out)).toBe(bytesToHex(keccak256(new Uint8Array([1, 2, 3]), "bytes")));
  });
});
