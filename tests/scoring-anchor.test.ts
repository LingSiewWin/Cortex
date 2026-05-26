/**
 * Cortex — scoring-anchor binding tests (offline; no Braga).
 *
 * Proves the citation-payload binding does what it claims:
 *   - the payload hash is deterministic and sensitive to scores (tamper → new hash)
 *   - reconstructScores rebuilds the latest tier/weight from the citation log alone
 *   - a citation's payload is verifiably included under the anchored MMR root,
 *     and tampering a score (or using the wrong root) breaks the proof.
 */

import { test, expect } from "bun:test";
import { hexToBytes, type Hex } from "viem";
import { jsonToPayload } from "@arkiv-network/sdk/utils";
import { MMR } from "../src/mirror/mmr";
import {
  reconstructScores,
  verifyScoreInclusion,
  citationLeafHash,
  type CitationPayload,
} from "../src/darwinian/score-replay";
import type { CitationScore } from "../src/darwinian/citation";

const KEY_A = ("0x" + "aa".repeat(32)) as Hex;
const KEY_B = ("0x" + "bb".repeat(32)) as Hex;

/** Build citation payload bytes exactly like act()/defaultWriteCitationEntity. */
function citationBytes(action: string, scores: CitationScore[], observedAtMs = 1000): Uint8Array {
  return jsonToPayload({
    action,
    citations: scores.map((s) => s.key),
    scores,
    observedAtMs,
  });
}

test("citation payload hash is deterministic and score-sensitive", () => {
  const a = citationBytes("buy", [{ key: KEY_A, tier: "episode", weight: 1.5, citationCount: 2 }]);
  const aSame = citationBytes("buy", [{ key: KEY_A, tier: "episode", weight: 1.5, citationCount: 2 }]);
  const aTampered = citationBytes("buy", [{ key: KEY_A, tier: "rule", weight: 4.0, citationCount: 2 }]);
  expect(citationLeafHash(a)).toBe(citationLeafHash(aSame)); // deterministic
  expect(citationLeafHash(a)).not.toBe(citationLeafHash(aTampered)); // weight/tier change → new hash
});

test("reconstructScores rebuilds latest tier/weight from the citation log (last-write-wins)", () => {
  const payloads: CitationPayload[] = [
    { scores: [{ key: KEY_A, tier: "observation", weight: 1.0, citationCount: 1 }] },
    { scores: [{ key: KEY_B, tier: "observation", weight: 1.0, citationCount: 1 }] },
    { scores: [{ key: KEY_A, tier: "episode", weight: 1.8, citationCount: 3 }] }, // A evolves
  ];
  const m = reconstructScores(payloads);
  expect(m.get(KEY_A.toLowerCase())).toEqual({ tier: "episode", weight: 1.8, citationCount: 3 });
  expect(m.get(KEY_B.toLowerCase())).toEqual({ tier: "observation", weight: 1.0, citationCount: 1 });
});

test("a citation's scores are verifiably included under the anchored root", () => {
  const mmr = new MMR();
  // a few unrelated leaves + the citation leaf
  mmr.append(hexToBytes(("0x" + "11".repeat(32)) as Hex));
  const payload = citationBytes("cite A", [{ key: KEY_A, tier: "rule", weight: 4.0, citationCount: 61 }]);
  const { leafIndex } = mmr.append(hexToBytes(citationLeafHash(payload)));
  mmr.append(hexToBytes(("0x" + "22".repeat(32)) as Hex));

  const root = mmr.getRootHex();
  const proof = mmr.getProof(leafIndex);

  // Honest path: real payload + real proof + real root → verified.
  expect(verifyScoreInclusion(payload, proof, root).ok).toBe(true);

  // Tamper: claim the memory was a rule/weight-9 — the bytes change, the hash
  // no longer matches the committed leaf → rejected.
  const tampered = citationBytes("cite A", [{ key: KEY_A, tier: "rule", weight: 9.0, citationCount: 61 }]);
  expect(verifyScoreInclusion(tampered, proof, root).ok).toBe(false);

  // Wrong root → rejected.
  const wrongRoot = ("0x" + "cc".repeat(32)) as Hex;
  expect(verifyScoreInclusion(payload, proof, wrongRoot).ok).toBe(false);
});
