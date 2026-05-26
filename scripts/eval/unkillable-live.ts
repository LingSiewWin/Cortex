/**
 * Cortex — "unkillable" LIVE capture (no induced faults, no fake data).
 *
 * Runs the REAL write path against the REAL chain, continuously, and records a
 * timeline of {head, spread, mode, pending, sent, failed} + every act() result.
 * It proves, against whatever Braga actually does:
 *   - the agent keeps citing (local scoring + enqueue) even while the chain is
 *     STALLED — act() returns "queued" with no chain call on the hot path;
 *   - the health-adaptive worker SKIPS draining when STALLED (no gas burned on a
 *     frozen head) and drains when HEALTHY;
 *   - buffered bundles are never lost — they reconcile to real tx on recovery.
 *
 * Citation targets are REAL on-chain entities (loaded from the local mirror, or
 * created when the chain is healthy). The only thing we don't control is WHEN
 * Braga stalls — so we just run and let the real chain write the proof.
 *
 * Run (background):  bun scripts/eval/unkillable-live.ts
 * Log:               scripts/eval/.unkillable-log.jsonl  (gitignored)
 */

import type { Hex } from "@arkiv-network/sdk";
import { ExpirationTime } from "@arkiv-network/sdk/utils";
import { privateKeyToAccount } from "viem/accounts";
import { singleCreate } from "../../src/lib/batch-writer.ts";
import { embedText } from "../../src/compression/embeddings.ts";
import { rabitqEncode, packCode } from "../../src/compression/rabitq.ts";
import { act } from "../../src/darwinian/citation.ts";
import { startAnchorWorker } from "../../src/agent/anchor-worker.ts";
import { sampleChainHead } from "../../src/mirror/chain-health.ts";
import { initMirrorDb, countOutbox } from "../../src/mirror/db.ts";
import { listMirroredEntities } from "../../src/mirror/replay.ts";
import { getUserPrimaryEOA } from "../../src/lib/arkiv-client.ts";
import { ENTITY_TYPE, BRAGA } from "../../src/constants.ts";

const LOG_URL = new URL("./.unkillable-log.jsonl", import.meta.url);
const TICK_MS = 30_000; // cite + log cadence
const BALANCE_FLOOR_WEI = 2_000_000_000_000_000n; // 0.002 GLM — stop creating below this
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function balanceWei(addr: Hex): Promise<bigint> {
  const r = await fetch(BRAGA.httpRpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [addr, "latest"] }),
  });
  return BigInt((await r.json()).result ?? "0x0");
}

async function logRow(row: Record<string, unknown>): Promise<void> {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...row });
  console.log(line);
  await Bun.write(LOG_URL, (await Bun.file(LOG_URL).text().catch(() => "")) + line + "\n");
}

async function main(): Promise<void> {
  if (!process.env.SESSION_KEY_PRIVATE_KEY) throw new Error("SESSION_KEY_PRIVATE_KEY not set");
  const pk = process.env.SESSION_KEY_PRIVATE_KEY;
  const sessionAddr = privateKeyToAccount((pk.startsWith("0x") ? pk : "0x" + pk) as Hex).address;
  const userEOA = getUserPrimaryEOA();
  const db = await initMirrorDb();

  console.log(`\n=== Cortex unkillable LIVE capture — real chain, no induced faults ===`);
  console.log(`session ${sessionAddr} · log → ${LOG_URL.pathname}\n`);

  // Health-adaptive worker (real head sampler) drains in the background.
  const worker = startAnchorWorker({ sampleHealth: () => sampleChainHead({ samples: 3, gapMs: 200 }) });

  // Working set of REAL on-chain entity keys to cite. Seed from the local mirror.
  const workingSet: Hex[] = [];
  for (const e of await listMirroredEntities({ state: "live", limit: 8 })) {
    if (e.attributes.some((a) => a.key === "entityType" && a.value === ENTITY_TYPE.OBSERVATION)) {
      workingSet.push(e.entityKey);
    }
    if (workingSet.length >= 3) break;
  }
  console.log(`seeded working set from mirror: ${workingSet.length} memorie(s)`);

  let tick = 0;
  let rotate = 0;
  // Run forever; Ctrl-C / kill to stop. Each tick: sample health, (maybe) ensure
  // targets, cite, and log the timeline row.
  for (;;) {
    tick++;
    let head = -1;
    let spread = -1;
    let mode = worker.currentMode();
    try {
      const s = await sampleChainHead({ samples: 4, gapMs: 250 });
      head = s.head;
      spread = s.spread;
      mode = worker.currentMode();
    } catch {
      /* sampler failed — chain unreachable */
    }
    const advancing = mode !== "stalled";

    // When HEALTHY and we have no targets, bootstrap 1 real on-chain memory.
    if (advancing && workingSet.length === 0) {
      try {
        const bal = await balanceWei(sessionAddr);
        if (bal >= BALANCE_FLOOR_WEI) {
          const emb = await embedText(`unkillable working memory ${Date.now()}`);
          const { entityKey } = await singleCreate({
            payload: packCode(rabitqEncode(emb)),
            contentType: "application/octet-stream",
            attributes: [{ key: "entityType", value: ENTITY_TYPE.OBSERVATION }],
            expiresInSeconds: ExpirationTime.fromMinutes(120),
          });
          workingSet.push(entityKey);
          await logRow({ event: "bootstrap_memory", entityKey, mode });
        }
      } catch (err) {
        await logRow({ event: "bootstrap_failed", error: err instanceof Error ? err.message : String(err), mode });
      }
    }

    // The hot-path proof: act() cites a real memory. This runs entirely locally
    // (scoring + enqueue) — it MUST succeed even while the chain is STALLED.
    let actStatus = "skipped(no-targets)";
    let outboxId: number | null = null;
    if (workingSet.length > 0) {
      const target = workingSet[rotate++ % workingSet.length]!;
      try {
        const r = await act({
          action: `unkillable tick ${tick}`,
          citations: [target],
          userPrimaryEOA: userEOA,
          sessionId: `unkillable-${tick}`,
          _deps: { db, lastRecallIds: () => new Set([target]) },
        });
        actStatus = r.status;
        outboxId = r.outboxId;
      } catch (err) {
        actStatus = `error:${err instanceof Error ? err.message : String(err)}`;
      }
    }

    await logRow({
      tick,
      head,
      spread,
      mode,
      cognition: actStatus, // "queued" during a stall = the agent kept thinking
      outboxId,
      formed: countOutbox(db), // total enqueued
      pending: countOutbox(db, "pending"), // buffered, not yet anchored
      anchored: countOutbox(db, "sent"), // reconciled to real tx
      deadLettered: countOutbox(db, "failed"),
    });

    await sleep(TICK_MS);
  }
}

main().catch((err) => {
  console.error("unkillable-live failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
