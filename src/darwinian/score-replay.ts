/**
 * Cortex — verifiable scoring from the on-chain citation log.
 *
 * The Darwinian state (tier + utility weight) is committed to the anchored MMR
 * root via the CITATION payload's `scores[]` (see citation.ts). This module is
 * the read/verify side that makes that binding useful:
 *
 *   - reconstructScores(): rebuild each memory's latest {tier, weight, count}
 *     PURELY from the on-chain citation payloads — no local SQLite. Proves the
 *     evolutionary history survives `rm cortex-mirror.sqlite`.
 *   - verifyScoreInclusion(): prove a citation's payload (and therefore its
 *     scores) is a leaf committed under a given anchored root. Tampering any
 *     score changes the payload hash and breaks the proof.
 *
 * Pure functions — no I/O, no chain calls. Callers feed in citation payloads
 * (fetched/decoded elsewhere) and MMR proofs.
 */

import { keccak256, bytesToHex, type Hex } from "viem";
import { verifyMMRProof, type MMRProof } from "../mirror/mmr.ts";
import type { CitationScore } from "./citation.ts";

/** A decoded citation payload (the JSON written on-chain by act()). */
export interface CitationPayload {
  action?: string;
  citations?: Hex[];
  scores?: CitationScore[];
  observedAtMs?: number;
}

/** Reconstructed per-memory state, keyed by lowercased entity key. */
export interface ReconstructedScore {
  tier: "observation" | "episode" | "rule";
  weight: number;
  citationCount: number;
}

/**
 * Rebuild each memory's LATEST scoring from an ordered list of citation
 * payloads (oldest → newest, i.e. chain/block order). Each citation carries the
 * cumulative post-act state, so last-write-wins per key is correct. Independent
 * of the local mirror — this is the "delete the SQLite, scores survive" proof.
 */
export function reconstructScores(
  payloads: ReadonlyArray<CitationPayload>,
): Map<string, ReconstructedScore> {
  const out = new Map<string, ReconstructedScore>();
  for (const p of payloads) {
    if (!p.scores) continue;
    for (const s of p.scores) {
      if (!s || typeof s.key !== "string") continue;
      out.set(s.key.toLowerCase(), {
        tier: s.tier,
        weight: s.weight,
        citationCount: s.citationCount,
      });
    }
  }
  return out;
}

export interface InclusionResult {
  ok: boolean;
  reason?: string;
}

/**
 * The MMR leaf for a citation = keccak256 of the EXACT on-chain payload bytes
 * (must match citation.ts defaultWriteCitationEntity + daemon hydrate).
 */
export function citationLeafHash(payloadBytes: Uint8Array): Hex {
  return bytesToHex(keccak256(payloadBytes, "bytes"));
}

/**
 * Verify a citation payload (and its embedded scores) is committed under an
 * anchored root. Checks: (1) the payload hashes to the proof's leaf — tamper
 * any byte/score and this fails; (2) the proof's root equals the anchored root
 * read from chain; (3) the MMR proof itself is internally valid (leaf → root).
 */
export function verifyScoreInclusion(
  payloadBytes: Uint8Array,
  proof: MMRProof,
  anchoredRoot: Hex,
): InclusionResult {
  const leaf = citationLeafHash(payloadBytes);
  if (proof.leafHash.toLowerCase() !== leaf.toLowerCase()) {
    return { ok: false, reason: "payload hash does not match the proof leaf (payload tampered or wrong proof)" };
  }
  if (proof.root.toLowerCase() !== anchoredRoot.toLowerCase()) {
    return { ok: false, reason: "proof root does not match the anchored on-chain root" };
  }
  if (!verifyMMRProof(proof)) {
    return { ok: false, reason: "MMR inclusion proof is invalid (leaf does not bag to root)" };
  }
  return { ok: true };
}
