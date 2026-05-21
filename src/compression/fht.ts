/**
 * Fast Hadamard Transform (FHT) — pure TypeScript, in-place.
 *
 * Why this exists: 1-bit RaBitQ needs a JL-style random rotation before
 * sign-quantization (see docs/RabitQ.md §2 Step C). The original paper uses a
 * dense Gaussian rotation; we substitute the HD pattern from QuaRot/SpinQuant
 * (random sign-flip diagonal D followed by a normalized Hadamard H), which is
 * provably a randomized isometry and costs O(D log D) adds/subtracts — no
 * multiplies on the hot path. This is exactly what the NTU library's
 * `FhtKacRotator` does in `utils/fht_avx.hpp`.
 *
 * Implementation notes:
 *   - The Hadamard matrix H_n is recursively defined; the iterative butterfly
 *     here is the standard Cooley–Tukey-style FHT, working block-by-block
 *     with doubling stride. Each pass is O(D); there are log2(D) passes.
 *   - At the end we divide by sqrt(D) so H is an orthonormal isometry.
 *   - The seeded sign-flip uses a deterministic xorshift PRNG seeded from a
 *     hex string; the rotation is reproducible across sessions and machines.
 */

/** Compute log2(n) and return -1 if n is not a power of two. */
function log2PowerOfTwo(n: number): number {
  if (n <= 0) return -1;
  let k = 0;
  let v = n;
  while ((v & 1) === 0) {
    v >>= 1;
    k++;
  }
  return v === 1 ? k : -1;
}

/**
 * In-place Hadamard transform on a Float32Array whose length is a power of two.
 * After this call, `x ← (1/√D) · H · x` where H is the natural-order Hadamard
 * matrix. Throws if D is not a power of two.
 */
export function fastHadamardTransform(x: Float32Array): void {
  const D = x.length;
  const logD = log2PowerOfTwo(D);
  if (logD < 0) {
    throw new Error(
      `fastHadamardTransform: length must be a power of two, got ${D}`,
    );
  }

  // Standard iterative FHT: for each stride h = 1, 2, 4, ..., D/2, walk the
  // array in blocks of 2h and apply the 2x2 butterfly [[1,1],[1,-1]].
  let h = 1;
  while (h < D) {
    const twoH = h << 1;
    for (let i = 0; i < D; i += twoH) {
      for (let j = i; j < i + h; j++) {
        const a = x[j]!;
        const b = x[j + h]!;
        x[j] = a + b;
        x[j + h] = a - b;
      }
    }
    h = twoH;
  }

  // Normalize by sqrt(D) so the operator is orthonormal.
  const invSqrtD = 1 / Math.sqrt(D);
  for (let i = 0; i < D; i++) {
    x[i] = x[i]! * invSqrtD;
  }
}

/**
 * Deterministic 32-bit PRNG seeded from an arbitrary string. We hash the
 * string with FNV-1a into 4 u32 words and drive an xorshift128 generator.
 * This avoids any reliance on `Math.random` and is reproducible across runs.
 */
function makeXorshift128(seedHex: string): () => number {
  // FNV-1a 32-bit, run four times with different offsets to derive four seeds.
  const FNV_OFFSET = 0x811c9dc5;
  const FNV_PRIME = 0x01000193;
  const seeds = new Uint32Array(4);
  for (let k = 0; k < 4; k++) {
    let h = (FNV_OFFSET ^ (k * 0x9e3779b9)) >>> 0;
    for (let i = 0; i < seedHex.length; i++) {
      h ^= seedHex.charCodeAt(i);
      h = Math.imul(h, FNV_PRIME) >>> 0;
    }
    // Ensure non-zero — xorshift cannot start at all-zero.
    seeds[k] = h === 0 ? 0x9e3779b9 : h;
  }

  let s0 = seeds[0]!;
  let s1 = seeds[1]!;
  let s2 = seeds[2]!;
  let s3 = seeds[3]!;

  return function next(): number {
    // xorshift128 — Marsaglia 2003.
    let t = s0 ^ (s0 << 11);
    t ^= t >>> 8;
    s0 = s1;
    s1 = s2;
    s2 = s3;
    s3 = (s3 ^ (s3 >>> 19)) ^ (t ^ (t >>> 8));
    return s3 >>> 0;
  };
}

/**
 * Apply a seeded HD rotation in place: first multiply by a diagonal of random
 * ±1 signs (drawn from the seeded PRNG), then run the FHT. The composed
 * operator is uniformly distributed enough across the orthogonal group for
 * RaBitQ's bound to hold in practice — this is exactly the
 * QuaRot/SpinQuant/`FhtKacRotator` construction.
 */
export function rotateWithSeed(x: Float32Array, seedHex: string): void {
  const D = x.length;
  const rng = makeXorshift128(seedHex);

  // Draw 32 sign bits per PRNG call; bit=1 keeps the sign, bit=0 flips it.
  // The mapping is arbitrary as long as it's deterministic.
  for (let i = 0; i < D; i += 32) {
    const word = rng();
    const lim = Math.min(32, D - i);
    for (let b = 0; b < lim; b++) {
      const bit = (word >>> b) & 1;
      if (bit === 0) x[i + b] = -x[i + b]!;
    }
  }

  fastHadamardTransform(x);
}
