/**
 * Cortex — distill.ts (semantic RULE synthesis) tests.
 *
 * Guards the previously-untested distillation orchestration via its `_deps`
 * seam (no LLM, no chain):
 *   - nothing ready → null
 *   - ready episodes → one LLM call → sealed RULE written → ownership promoted
 *   - episodes with no loadable text → null
 *   - ownership-transfer failure does NOT lose the rule (warn-not-abort invariant)
 */

import { test, expect } from "bun:test";
import type { Hex } from "@arkiv-network/sdk";
import { distillIfReady } from "../src/darwinian/distill";
import type { CitationStats } from "../src/darwinian/citation";

const USER = ("0x" + "ab".repeat(20)) as Hex;
const EP1 = ("0x" + "11".repeat(32)) as Hex;
const RULE_KEY = ("0x" + "99".repeat(32)) as Hex;

function ready(key: Hex): CitationStats {
  return { entityKey: key } as CitationStats;
}

test("distillIfReady returns null when nothing is ready", async () => {
  const r = await distillIfReady({
    userPrimaryEOA: USER,
    _deps: { listReady: async () => [] },
  });
  expect(r).toBeNull();
});

test("distillIfReady distills ready episodes into a RULE and promotes ownership", async () => {
  let wrote = false;
  let promotedToUser = false;
  const r = await distillIfReady({
    userPrimaryEOA: USER,
    _deps: {
      listReady: async () => [ready(EP1)],
      loadEpisode: async () => "always verify a contract is audited before integrating",
      callLlm: async (prompt) => {
        expect(prompt).toContain("Episode snippets");
        return "Verify audits before integrating.";
      },
      writeRule: async (text, attrs) => {
        wrote = true;
        expect(text).toBe("Verify audits before integrating.");
        expect(attrs.find((a) => a.key === "entityType")?.value).toBe("rule");
        expect(attrs.find((a) => a.key === "sourceEpisodeCount")?.value).toBe(1);
        return { entityKey: RULE_KEY, txHash: "0xtx" };
      },
      promote: async (keys, eoa) => {
        promotedToUser = eoa === USER;
        expect(keys[0]).toBe(RULE_KEY);
        return { txHash: "0xpromote" };
      },
    },
  });
  expect(r).not.toBeNull();
  expect(r!.ruleText).toBe("Verify audits before integrating.");
  expect(r!.sourceEpisodeKeys).toEqual([EP1]);
  expect(wrote).toBe(true);
  expect(promotedToUser).toBe(true);
});

test("distillIfReady returns null when no episode yields loadable text", async () => {
  const r = await distillIfReady({
    userPrimaryEOA: USER,
    _deps: {
      listReady: async () => [ready(EP1)],
      loadEpisode: async () => undefined,
    },
  });
  expect(r).toBeNull();
});

test("distillIfReady still returns the rule when ownership transfer fails", async () => {
  const r = await distillIfReady({
    userPrimaryEOA: USER,
    _deps: {
      listReady: async () => [ready(EP1)],
      loadEpisode: async () => "text",
      callLlm: async () => "rule",
      writeRule: async () => ({ entityKey: RULE_KEY, txHash: "0xtx" }),
      promote: async () => {
        throw new Error("promote failed");
      },
    },
  });
  expect(r).not.toBeNull();
  expect(r!.ruleText).toBe("rule");
});
