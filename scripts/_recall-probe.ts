/**
 * Cortex — recall probe (internal helper for the sovereignty proof).
 *
 * Runs a single recall against whatever mirror CORTEX_MIRROR_PATH points at,
 * using whatever wallet material is in env (CORTEX_USER_SIGNATURE /
 * CORTEX_USER_PRIVATE_KEY — or none). Prints HIT/MISS for the target entity and
 * exits 0 on HIT, 1 on MISS. The orchestrator (scripts/sovereignty-proof.ts)
 * spawns this in a fresh process to simulate a clean machine.
 */

import { recall, _resetLastRecallIds } from "../src/darwinian/recall";

const query = process.env.PROBE_QUERY;
const target = process.env.PROBE_ENTITY;
if (!query || !target) {
  console.error("PROBE_QUERY and PROBE_ENTITY env are required");
  process.exit(2);
}

_resetLastRecallIds();
const hits = await recall({ query, k: 5 });
const hit = hits.some((h) => h.entityKey === target);
console.log(`PROBE ${hit ? "HIT" : "MISS"} — ${hits.length} hits, target ${hit ? "present" : "absent"}`);
process.exit(hit ? 0 : 1);
