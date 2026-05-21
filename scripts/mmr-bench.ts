/**
 * Cortex — MMR accumulator benchmark.
 *
 * The Phase 12 gating bench. Per user mandate:
 *   "Do not touch the Arkiv relayer until we prove the local MMR can ingest
 *    10,000 leaves in under 100ms."
 *
 * Run: bun scripts/mmr-bench.ts
 *
 * Outputs three scenarios:
 *   1. 10k appends + 1 final root computation (the cold cache case)
 *   2. 10k appends with a root computation after EVERY append (worst case)
 *   3. Proof generation + verification round-trip across random leaves
 *
 * Exits 0 if scenario 1 is under 100ms; nonzero otherwise. This makes the
 * bench safe to call from CI as a pre-commit gate.
 */

import { keccak256 } from "viem";
import { MMR, verifyMMRProof } from "../src/mirror/mmr";

const TARGET_MS = 100;

function leaf(seed: number): Uint8Array {
  const input = new Uint8Array(32);
  input[0] = seed & 0xff;
  input[1] = (seed >> 8) & 0xff;
  input[2] = (seed >> 16) & 0xff;
  input[3] = (seed >> 24) & 0xff;
  return keccak256(input, "bytes");
}

function fmtMs(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(1)}μs`;
  if (ms < 1000) return `${ms.toFixed(2)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function row(label: string, value: string): void {
  console.log(`  ${label.padEnd(36)} ${value}`);
}

async function main(): Promise<void> {
  console.log("\n=== Cortex MMR benchmark ===\n");
  console.log(`Target: 10,000 appends + final root under ${TARGET_MS}ms\n`);

  // ----------------------------------------------------------------------
  // Scenario 1 — cold root after 10k appends (Phase 12 gate)
  // ----------------------------------------------------------------------
  console.log("[1] 10,000 appends + 1 final root computation");
  {
    const mmr = new MMR();
    const t0 = performance.now();
    for (let i = 0; i < 10_000; i++) {
      mmr.append(leaf(i));
    }
    const rootBeforeT = performance.now();
    const rootHex = mmr.getRootHex();
    const t1 = performance.now();

    const totalMs = t1 - t0;
    const appendsMs = rootBeforeT - t0;
    const rootMs = t1 - rootBeforeT;

    row("Leaves:", "10,000");
    row("Append phase:", fmtMs(appendsMs));
    row("Root computation:", fmtMs(rootMs));
    row("Total:", fmtMs(totalMs));
    row("Per-leaf (append):", fmtMs(appendsMs / 10_000));
    row("Final root:", rootHex);
    row(
      "Result:",
      totalMs < TARGET_MS
        ? `✅ PASS (under ${TARGET_MS}ms)`
        : `❌ FAIL (over ${TARGET_MS}ms)`,
    );
    console.log();

    if (totalMs >= TARGET_MS) {
      console.log(
        `❌ MMR ingestion is too slow. Phase 12 gate FAILED. Do not proceed to Phase 13.`,
      );
      process.exit(1);
    }
  }

  // ----------------------------------------------------------------------
  // Scenario 2 — root after every append (worst case)
  // ----------------------------------------------------------------------
  console.log("[2] 10,000 appends with root recomputed after EVERY append");
  {
    const mmr = new MMR();
    const t0 = performance.now();
    for (let i = 0; i < 10_000; i++) {
      mmr.append(leaf(i));
      mmr.getRoot(); // Force recomputation each step
    }
    const t1 = performance.now();

    const totalMs = t1 - t0;
    row("Total:", fmtMs(totalMs));
    row("Per-(append+root):", fmtMs(totalMs / 10_000));
    row(
      "Note:",
      "Each act() decision triggers a commit at most — this is the upper bound.",
    );
    console.log();
  }

  // ----------------------------------------------------------------------
  // Scenario 3 — proof gen + verification across random leaves
  // ----------------------------------------------------------------------
  console.log("[3] Proof generation + verification (100 random samples)");
  {
    const mmr = new MMR();
    const N = 10_000;
    for (let i = 0; i < N; i++) mmr.append(leaf(i));

    const SAMPLES = 100;
    let totalGen = 0;
    let totalVer = 0;
    let allVerified = true;

    for (let s = 0; s < SAMPLES; s++) {
      const idx = Math.floor(Math.random() * N);

      const g0 = performance.now();
      const proof = mmr.getProof(idx);
      const g1 = performance.now();
      totalGen += g1 - g0;

      const v0 = performance.now();
      const ok = verifyMMRProof(proof);
      const v1 = performance.now();
      totalVer += v1 - v0;

      if (!ok) allVerified = false;
    }

    row("Avg proof gen:", fmtMs(totalGen / SAMPLES));
    row("Avg proof verify:", fmtMs(totalVer / SAMPLES));
    row(
      "All verified:",
      allVerified ? "✅ yes" : "❌ NO — verification failure",
    );
    console.log();

    if (!allVerified) {
      console.error(
        "❌ Proof verification failure — MMR implementation has a bug.",
      );
      process.exit(2);
    }
  }

  console.log("=== Bench complete ===");
  console.log("");
  console.log(
    "Phase 12 gate: ✅ PASSED. MMR is fast enough to anchor on every",
  );
  console.log(
    "agent decision without bottlenecking the local execution loop.",
  );
  console.log("");
  console.log(
    "Next step: Phase 13 — wire commitStateRoot('act') into the agent's",
  );
  console.log("act() flow and broadcast the root to Arkiv via batch-writer.");
}

main().catch((err) => {
  console.error("\n[mmr-bench] fatal:", err);
  process.exit(1);
});
