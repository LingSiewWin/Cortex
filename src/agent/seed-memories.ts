/**
 * Cortex — shared seed-memories core.
 *
 * Extracted from scripts/seed-memories.ts so the same logic can be invoked
 * from a CLI (`bun run seed`) AND from the dashboard's POST /api/seed-memories
 * endpoint. Same observations, same sealing, same single-tx batch.
 *
 * Identity follows the singleton:
 *   - `createMemories` seals with the current payload key (browser-adopted or env)
 *   - `$creator` is the session-key relayer (env, paid by us)
 *   - `$owner` flows to the singleton's ownerAddress via the existing batch-writer path
 *
 * Net effect: after adoption, calling `seedMemories()` writes 20 observations
 * sealed with the connected wallet's key, ready for the autonomous loop to cite.
 */

import type { Hex } from "@arkiv-network/sdk";
import { ExpirationTime } from "@arkiv-network/sdk/utils";
import { createMemories } from "../lib/batch-writer";
import { embedAndQuantize } from "../compression/embeddings";
import { initMirrorDb } from "../mirror/db";
import { ENTITY_TYPE } from "../constants";

/** Each answers one DEFAULT_QUERY_POOL query so recall scores it highly. */
export const SEED_OBSERVATIONS: { marker: string; text: string }[] = [
  {
    marker: "reentrancy",
    text: "Solidity reentrancy is mitigated by the checks-effects-interactions pattern and reentrancy guard modifiers; never make external calls before updating state.",
  },
  {
    marker: "compression",
    text: "RaBitQ 1-bit rotational quantization compresses a 1536-dimension float32 embedding to 198 bytes (about 31x) with an unbiased inner-product estimator for retrieval.",
  },
  {
    marker: "mmr",
    text: "MMR proof verification walks the leaf hash up its sibling hashes to its peak, then bags all peaks right-to-left and checks the result equals the claimed root.",
  },
  {
    marker: "erc-stack",
    text: "Cortex composes EIP-712 typed sessions, ERC-1271 and ERC-6492 smart-wallet signatures, ERC-4361 SIWE login, ERC-5792 capability probing, and ERC-5169 scriptURI.",
  },
  {
    marker: "accumulative-extend",
    text: "Accumulative extend preserves remaining lease time plus a reinforcement delta, so frequently cited memories grow their lifespan instead of resetting — LTP-faithful, not REPLACE-naive.",
  },
  {
    marker: "ownership",
    text: "The session key is the immutable creator for tamper-proof attribution, while the user's primary EOA is the mutable owner that controls extend, update, and delete.",
  },
  {
    marker: "semantic-tier",
    text: "Semantic tier distills episodic memories into plain-text rules with a one-year lease on Arkiv after enough cross-session citations trigger LLM consolidation.",
  },
  {
    marker: "darwinian",
    text: "The Darwinian primitive is citation-driven reinforcement: every act() that cites a memory extends its on-chain lease, so useful thoughts survive and unused ones evict for free.",
  },
  {
    marker: "mirror",
    text: "The SQLite mirror catches every Arkiv entity event locally so you can replay and decrypt memories from your wallet even if the Cortex backend disappears.",
  },
  {
    marker: "sealed-payload",
    text: "Core memories are client-side sealed with AES-256-GCM derived from a wallet signature; Arkiv stores ciphertext while recall decrypts at read time from the local mirror.",
  },
  {
    marker: "document-tier",
    text: "Document Tier seals full note text plus embeddings in one CBOR payload so long-form Obsidian notes recover losslessly from the chain with wallet-only decryption.",
  },
  {
    marker: "obsidian-bridge",
    text: "The Obsidian sync daemon watches the vault, embeds changed notes, writes sealed document entities to Arkiv, and stamps cortex frontmatter back for idempotent re-sync.",
  },
  {
    marker: "utility-weight",
    text: "SEDM-inspired utility weights scale lease reinforcement by prior citation utility so frequently useful memories earn longer leases without flat plus-twenty-four-hour spam.",
  },
  {
    marker: "openclaw",
    text: "The memory-arkiv OpenClaw plugin fills the single memory slot with Arkiv-backed store and recall tools so agent memory is portable and verifiable across runtimes.",
  },
  {
    marker: "mcp-tools",
    text: "Cortex exposes cortex_recall, cortex_act, and cortex_store_document over MCP stdio so Claude Code and Cursor attach the same Darwinian engine the dashboard runs.",
  },
  {
    marker: "eviction",
    text: "When a memory's expiresAt block passes, Arkiv L1Block sync evicts it for free; the mirror keeps a cold archive for resurrection on recall miss.",
  },
  {
    marker: "session-key",
    text: "The session-key EOA signs Arkiv writes while the user's primary wallet owns extend and delete, solving session death without losing memory ownership.",
  },
  {
    marker: "braga",
    text: "Cortex runs on Arkiv Braga testnet with two-second blocks, PROJECT_ATTRIBUTE filtering, and accumulative extend verified end-to-end on the precompile.",
  },
  {
    marker: "hybrid-recall",
    text: "Recall fuses RaBitQ Hamming similarity with utility weights and optional full-precision rerank for document-tier notes stored in the local mirror.",
  },
];

export interface SeedResult {
  txHash: Hex;
  entityKeys: Hex[];
  markers: string[];
  count: number;
}

/**
 * Embed + seal + batch-create all SEED_OBSERVATIONS in one tx. The mirror is
 * initialized first so the daemon picks them up immediately when it next polls.
 */
export async function seedMemories(): Promise<SeedResult> {
  await initMirrorDb();

  const creates = [];
  for (const obs of SEED_OBSERVATIONS) {
    const { bytes } = await embedAndQuantize(obs.text);
    creates.push({
      payload: bytes,
      contentType: "application/octet-stream",
      attributes: [
        { key: "entityType", value: ENTITY_TYPE.OBSERVATION },
        { key: "marker", value: obs.marker },
        { key: "seed", value: Date.now() },
      ],
      expiresInSeconds: ExpirationTime.fromMinutes(60),
    });
  }

  const result = await createMemories(creates);
  return {
    txHash: result.txHash,
    entityKeys: result.entityKeys,
    markers: SEED_OBSERVATIONS.map((o) => o.marker),
    count: result.entityKeys.length,
  };
}
