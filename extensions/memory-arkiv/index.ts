/**
 * memory-arkiv — Cortex as an OpenClaw memory plugin.
 *
 * Fills OpenClaw's single active memory slot (`plugins.slots.memory: "memory-arkiv"`)
 * with Cortex's sovereign, decay-aware engine instead of a local store. The model-
 * facing tools are thin wrappers over Cortex's pure adapter (../../src/openclaw/adapter):
 *   memory_recall → Cortex recall (decay-aware, utility-weighted, decrypted in RAM)
 *   memory_store  → Cortex createMemory (RaBitQ-compressed, wallet-sealed on Arkiv)
 *
 * Contract per docs.openclaw.ai/plugins/building-plugins: `definePluginEntry` from the
 * focused SDK subpath, `register(api)` + `api.registerTool`, manifest declares the
 * tools in `contracts.tools` and `kind:"memory"`.
 *
 * This shell is a separate workspace (its own package.json/tsconfig); it is excluded
 * from Cortex's tsc because it imports `openclaw/plugin-sdk/*`, which only resolves
 * where the `openclaw` package is installed. Build/verify it there:
 *   openclaw plugins install --link ./extensions/memory-arkiv
 *   openclaw gateway restart
 *   openclaw plugins inspect memory-arkiv --runtime --json
 */

import { Type } from "typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { memoryRecall, memoryStore } from "../../src/openclaw/adapter.ts";

export default definePluginEntry({
  id: "memory-arkiv",
  name: "Cortex (Arkiv) Memory",
  description: "Sovereign, decay-aware agent memory on Arkiv.",
  register(api) {
    api.registerTool({
      name: "memory_recall",
      description:
        "Recall the most relevant memories from Cortex (Arkiv) for a query. " +
        "Returns decay-aware, utility-weighted hits decrypted with your wallet.",
      parameters: Type.Object({
        query: Type.String({ description: "What to recall." }),
        k: Type.Optional(Type.Number({ description: "Max hits (default 5)." })),
      }),
      async execute(_id, params: { query: string; k?: number }) {
        return memoryRecall(params);
      },
    });

    api.registerTool({
      name: "memory_store",
      description:
        "Store an observation in Cortex: RaBitQ-compressed, sealed with your wallet key, " +
        "written to Arkiv with a 1h lease that grows each time the memory is cited.",
      parameters: Type.Object({
        text: Type.String({ description: "The memory text to store." }),
      }),
      async execute(_id, params: { text: string }) {
        return memoryStore(params);
      },
    });
  },
});
