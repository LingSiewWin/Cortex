/**
 * Cortex — Merkle Mountain Range accumulator.
 *
 * Phase 12: state dictates settlement. This is the local state machine that
 * Phase 13 will anchor to Arkiv.
 *
 * Algorithm (Grin / Polkadot / Mina-style MMR):
 *   - Append-only. New leaves push onto level 0.
 *   - When level h has an even count, the last two combine into a parent at
 *     level h+1. Recurse.
 *   - A "peak" at level h is the last node at that level WHEN the count is
 *     odd. Peaks are the unpaired nodes — the mountains.
 *   - Root = bag(peaks) right-to-left. Hash highest peak with bag-of-rest.
 *
 * Invariants (asserted by tests):
 *   - append is O(log N) worst case, O(1) amortized
 *   - getRoot() is O(log N) given cached levels
 *   - getProof / verify round-trip is exact
 *   - Same leaf sequence → byte-identical root (determinism)
 *
 * Hash function: keccak256 (matches EVM precompile + Arkiv anchors).
 *
 * v1 limitation: this MMR commits to SET INCLUSION ("memory X was in the
 * history at root R"), not to NEAREST-NEIGHBOR ("X is the closest match
 * to query Q"). Trustless top-K via KZG vector commitments is the v2 work.
 * See docs/ROADMAP.md when written.
 */

import { keccak256, bytesToHex, type Hex } from "viem";

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/** keccak256 of a single byte buffer. Returns 32-byte Uint8Array. */
export function hashBytes(input: Uint8Array): Uint8Array {
  return keccak256(input, "bytes");
}

/** keccak256(left || right) — used to combine sibling hashes into a parent. */
function hashPair(left: Uint8Array, right: Uint8Array): Uint8Array {
  const buf = new Uint8Array(left.length + right.length);
  buf.set(left, 0);
  buf.set(right, left.length);
  return keccak256(buf, "bytes");
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

const ZERO_ROOT = new Uint8Array(32);

// ---------------------------------------------------------------------------
// Proof structures
// ---------------------------------------------------------------------------

export interface MMRProofStep {
  /** Sibling hash at this level, hex-encoded. */
  sibling: Hex;
  /**
   * True when the leaf-side node was the LEFT child at this step — i.e. the
   * verifier hashes (currentAcc || sibling). False means right child:
   * verifier hashes (sibling || currentAcc).
   */
  isLeft: boolean;
}

export interface MMRProof {
  leafIndex: number;
  leafHash: Hex;
  leafCount: number;
  /** Sibling hashes from leaf up to its peak, in order. */
  path: MMRProofStep[];
  /**
   * Position of this leaf's peak in the global peak ordering
   * (0 = highest/leftmost peak, peakCount-1 = lowest/rightmost).
   */
  peakIndex: number;
  /** All OTHER peaks in bagging order (length = peakCount - 1). */
  siblingPeaks: Hex[];
  /** Claimed root. Verifier checks this is what bagging produces. */
  root: Hex;
}

// ---------------------------------------------------------------------------
// MMR class
// ---------------------------------------------------------------------------

export class MMR {
  /**
   * levels[h] = array of every node ever computed at height h.
   * Nodes are never removed. Higher-height nodes appear lazily as pairs complete.
   */
  private levels: Uint8Array[][] = [[]];
  private leafCount = 0;
  /** Lazy root cache. Invalidated on every append. */
  private rootCache: { count: number; root: Uint8Array } | null = null;

  /** Number of leaves appended so far. */
  size(): number {
    return this.leafCount;
  }

  /**
   * Append a leaf hash. MUST be exactly 32 bytes (the keccak256 of the payload
   * the caller wants to commit to). Returns the leaf index in the MMR.
   */
  append(leafHash: Uint8Array): { leafIndex: number } {
    if (leafHash.length !== 32) {
      throw new Error(
        `MMR.append: leaf hash must be 32 bytes, got ${leafHash.length}`,
      );
    }
    const leafIndex = this.leafCount;
    this.leafCount++;
    this.rootCache = null;

    // Push leaf
    this.levels[0]!.push(leafHash);

    // Walk up: at each level, if the count is even, combine last two into parent.
    // This is the canonical MMR insertion algorithm: every newly-completed pair
    // bubbles up exactly one level.
    let h = 0;
    while (true) {
      const level = this.levels[h]!;
      if (level.length % 2 !== 0) break; // can't combine — odd count
      const right = level[level.length - 1]!;
      const left = level[level.length - 2]!;
      const parent = hashPair(left, right);
      if (!this.levels[h + 1]) this.levels[h + 1] = [];
      this.levels[h + 1]!.push(parent);
      h++;
    }

    return { leafIndex };
  }

  /**
   * Returns the current root. O(log N) — there are at most log2(N) peaks.
   * Empty MMR returns the zero hash.
   */
  getRoot(): Uint8Array {
    if (this.rootCache && this.rootCache.count === this.leafCount) {
      return this.rootCache.root;
    }
    if (this.leafCount === 0) return ZERO_ROOT;

    const peaks = this.collectPeakHashes();
    const root = bagPeaks(peaks);
    this.rootCache = { count: this.leafCount, root };
    return root;
  }

  /** Convenience — root as 0x-prefixed hex. */
  getRootHex(): Hex {
    return bytesToHex(this.getRoot());
  }

  /**
   * Build a verifiable inclusion proof for `leafIndex`. Throws if out of range.
   * O(log N) — walks the path up + collects peaks.
   */
  getProof(leafIndex: number): MMRProof {
    if (leafIndex < 0 || leafIndex >= this.leafCount) {
      throw new Error(
        `MMR.getProof: leaf index ${leafIndex} out of range [0, ${this.leafCount})`,
      );
    }

    const leafHash = this.levels[0]![leafIndex]!;
    const path: MMRProofStep[] = [];

    // Walk up. At each level, find sibling. If no sibling exists, we've hit a peak.
    let h = 0;
    let idxAtH = leafIndex;
    while (true) {
      const isLeft = (idxAtH & 1) === 0;
      const siblingIdx = isLeft ? idxAtH + 1 : idxAtH - 1;
      const levelArr = this.levels[h]!;

      if (siblingIdx < 0 || siblingIdx >= levelArr.length) {
        // No sibling — current node is the peak at level h.
        break;
      }

      path.push({
        sibling: bytesToHex(levelArr[siblingIdx]!),
        isLeft,
      });

      // Move to parent
      h += 1;
      idxAtH >>= 1;
    }

    // Determine which peak this is in global ordering.
    const allPeaks = this.collectPeakDescriptors();
    const peakIndex = allPeaks.findIndex((p) => p.height === h);
    if (peakIndex === -1) {
      throw new Error(
        `MMR.getProof: internal — leaf ${leafIndex} mapped to nonexistent peak at height ${h}`,
      );
    }
    const siblingPeaks: Hex[] = [];
    for (let i = 0; i < allPeaks.length; i++) {
      if (i !== peakIndex) siblingPeaks.push(bytesToHex(allPeaks[i]!.hash));
    }

    return {
      leafIndex,
      leafHash: bytesToHex(leafHash),
      leafCount: this.leafCount,
      path,
      peakIndex,
      siblingPeaks,
      root: bytesToHex(this.getRoot()),
    };
  }

  /**
   * Peaks in BAGGING ORDER: highest first, lowest last. The leftmost peak in
   * the diagram is the largest mountain; the rightmost is the most recent
   * (smallest) one.
   */
  private collectPeakDescriptors(): Array<{ height: number; hash: Uint8Array }> {
    const peaks: Array<{ height: number; hash: Uint8Array }> = [];
    for (let h = this.levels.length - 1; h >= 0; h--) {
      const level = this.levels[h];
      if (!level || level.length === 0) continue;
      if ((level.length & 1) === 1) {
        // Odd count → last node at this level is a peak
        peaks.push({ height: h, hash: level[level.length - 1]! });
      }
    }
    return peaks;
  }

  private collectPeakHashes(): Uint8Array[] {
    return this.collectPeakDescriptors().map((p) => p.hash);
  }
}

// ---------------------------------------------------------------------------
// Bagging (peaks → root)
// ---------------------------------------------------------------------------

function bagPeaks(peaks: Uint8Array[]): Uint8Array {
  if (peaks.length === 0) return ZERO_ROOT;
  if (peaks.length === 1) return peaks[0]!;
  // Right-to-left fold. peaks[0] is highest (leftmost mountain), peaks[N-1] is lowest.
  // bag = peaks[N-1]; bag = hash(peaks[N-2], bag); ...
  let bag = peaks[peaks.length - 1]!;
  for (let i = peaks.length - 2; i >= 0; i--) {
    bag = hashPair(peaks[i]!, bag);
  }
  return bag;
}

// ---------------------------------------------------------------------------
// Stateless verifier
// ---------------------------------------------------------------------------

/**
 * Verify an MMR inclusion proof. Does NOT need access to the MMR itself —
 * just the proof + the claimed root. This is the function a client (or a
 * future on-chain verifier) runs.
 */
export function verifyMMRProof(proof: MMRProof): boolean {
  // 1. Walk path: hash leaf with siblings up to the leaf's peak.
  let acc: Uint8Array;
  try {
    acc = hexToBytes(proof.leafHash);
  } catch {
    return false;
  }
  if (acc.length !== 32) return false;

  for (const step of proof.path) {
    let sibling: Uint8Array;
    try {
      sibling = hexToBytes(step.sibling);
    } catch {
      return false;
    }
    if (sibling.length !== 32) return false;
    acc = step.isLeft ? hashPair(acc, sibling) : hashPair(sibling, acc);
  }
  // `acc` is now the leaf's peak.

  // 2. Reconstruct full peak list: insert `acc` at peakIndex.
  const totalPeaks = proof.siblingPeaks.length + 1;
  if (proof.peakIndex < 0 || proof.peakIndex >= totalPeaks) return false;

  const peaks: Uint8Array[] = new Array(totalPeaks);
  let sIdx = 0;
  for (let i = 0; i < totalPeaks; i++) {
    if (i === proof.peakIndex) {
      peaks[i] = acc;
    } else {
      let p: Uint8Array;
      try {
        p = hexToBytes(proof.siblingPeaks[sIdx++]!);
      } catch {
        return false;
      }
      if (p.length !== 32) return false;
      peaks[i] = p;
    }
  }

  // 3. Bag → root.
  const computedRoot = bagPeaks(peaks);

  // 4. Compare.
  let claimed: Uint8Array;
  try {
    claimed = hexToBytes(proof.root);
  } catch {
    return false;
  }
  return bytesEqual(computedRoot, claimed);
}

// ---------------------------------------------------------------------------
// Small hex helper (viem's hexToBytes throws; we want a try-catch surface)
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("odd hex length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error("invalid hex char");
    out[i] = byte;
  }
  return out;
}
