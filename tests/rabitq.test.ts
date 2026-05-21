/**
 * Cortex — RaBitQ compressor unit tests.
 *
 * Pure in-memory tests; no network, no Braga. Verifies:
 *   1. pack/unpack round-trip is byte-exact
 *   2. norm preservation: estimator on (v, encode(v)) ≈ ‖v‖²
 *   3. correlation: encoding 100 random unit vectors and querying with one of
 *      them ranks the correct vector in the top-3 by inner-product estimate
 *   4. pinned pack size (198 bytes)
 *   5. determinism: encoding the same vector twice yields byte-identical packs
 */

import { test, expect } from "bun:test";
import {
  packCode,
  rabitqEncode,
  rabitqInnerProduct,
  unpackCode,
  f16ToF32,
  f32ToF16,
} from "../src/compression/rabitq";

const EMBED_DIM = 1536;
const PACK_SIZE = 198;

/** Deterministic LCG so the test vectors are reproducible across runs. */
function makeLcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

/** Random Float32Array of length n, components in N(0, 1) via Box–Muller. */
function randomGaussian(n: number, seed: number): Float32Array {
  const rng = makeLcg(seed);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 2) {
    let u1 = rng();
    const u2 = rng();
    if (u1 < 1e-12) u1 = 1e-12;
    const r = Math.sqrt(-2 * Math.log(u1));
    const theta = 2 * Math.PI * u2;
    out[i] = r * Math.cos(theta);
    if (i + 1 < n) out[i + 1] = r * Math.sin(theta);
  }
  return out;
}

function l2Norm(v: Float32Array): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i]!;
    s += x * x;
  }
  return Math.sqrt(s);
}

function normalize(v: Float32Array): Float32Array {
  const n = l2Norm(v);
  if (n === 0) return v;
  const out = new Float32Array(v.length);
  const inv = 1 / n;
  for (let i = 0; i < v.length; i++) out[i] = v[i]! * inv;
  return out;
}

test("pack size is pinned at 198 bytes", () => {
  const v = randomGaussian(EMBED_DIM, 1);
  const code = rabitqEncode(v);
  const bytes = packCode(code);
  expect(bytes.length).toBe(PACK_SIZE);
});

test("packCode/unpackCode round-trips exactly", () => {
  const v = randomGaussian(EMBED_DIM, 42);
  const code = rabitqEncode(v);
  const bytes = packCode(code);
  const restored = unpackCode(bytes);

  expect(restored.signs.length).toBe(code.signs.length);
  for (let i = 0; i < code.signs.length; i++) {
    expect(restored.signs[i]).toBe(code.signs[i]!);
  }
  expect(restored.normFp16).toBe(code.normFp16);
  expect(restored.alignFp16).toBe(code.alignFp16);
});

test("encoding the same vector twice is byte-identical", () => {
  const v = randomGaussian(EMBED_DIM, 7);
  const a = packCode(rabitqEncode(v));
  const b = packCode(rabitqEncode(v));
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) {
    expect(a[i]).toBe(b[i]!);
  }
});

test("norm preservation: <v, encode(v)> ≈ ‖v‖² within 5%", () => {
  // Try a handful of seeds so we don't ride on one lucky draw.
  for (const seed of [11, 23, 37, 53]) {
    const v = randomGaussian(EMBED_DIM, seed);
    const expected = l2Norm(v) ** 2;
    const code = rabitqEncode(v);
    const estimated = rabitqInnerProduct(v, code);
    const relErr = Math.abs(estimated - expected) / Math.abs(expected);
    // Spec says within 5%; 1-bit RaBitQ on D=1536 typically lands well under
    // 3% for the self-inner-product, but the 5% bound is the contract.
    expect(relErr).toBeLessThan(0.05);
  }
});

test("recall: query ranks its source vector in top-3 of 100 random vectors", () => {
  const N = 100;
  const queryIdx = 42;

  // Random unit vectors — encode them all and store the codes.
  const vectors: Float32Array[] = [];
  const codes = [];
  for (let i = 0; i < N; i++) {
    const v = normalize(randomGaussian(EMBED_DIM, 100 + i));
    vectors.push(v);
    codes.push(rabitqEncode(v));
  }

  const query = vectors[queryIdx]!;

  // Score every code against the query, then find the rank of the true match.
  const scored: Array<{ idx: number; score: number }> = [];
  for (let i = 0; i < N; i++) {
    scored.push({ idx: i, score: rabitqInnerProduct(query, codes[i]!) });
  }
  scored.sort((a, b) => b.score - a.score);

  const rank = scored.findIndex((s) => s.idx === queryIdx);
  expect(rank).toBeGreaterThanOrEqual(0);
  expect(rank).toBeLessThan(3);
});

test("fp16 round-trip is within 0.1% on values in [-1e3, 1e3]", () => {
  // Sanity check the bit-twiddle since we hand-rolled it.
  const samples = [0, 1, -1, 0.5, -0.5, 3.14159, 100, -100, 0.001, 1e3, -1e3];
  for (const v of samples) {
    const back = f16ToF32(f32ToF16(v));
    if (v === 0) {
      expect(back).toBe(0);
    } else {
      const relErr = Math.abs(back - v) / Math.abs(v);
      expect(relErr).toBeLessThan(1e-3);
    }
  }
  // Special values
  expect(f16ToF32(f32ToF16(0))).toBe(0);
});

test("unpackCode rejects wrong-length buffers", () => {
  expect(() => unpackCode(new Uint8Array(10))).toThrow();
  expect(() => unpackCode(new Uint8Array(PACK_SIZE - 1))).toThrow();
});
