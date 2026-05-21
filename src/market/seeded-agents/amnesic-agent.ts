/**
 * Cortex — seeded amnesic agent for the live demo.
 *
 * Purpose: showcase the Darwinian fitness story. This agent dumps low-quality
 * observations to Arkiv with the default 1-hour expiration and never cites
 * them, so they never get extended and decay off the chain for free. Judges
 * compare it side-by-side with the citing agent in the dashboard — same
 * starting state, opposite long-term cost curve.
 *
 * Why it exists in market/seeded-agents/ rather than darwinian/: the live demo
 * runs the three agents (seller, buyer, amnesic) as one ensemble. Keeping the
 * three start() functions adjacent makes the dashboard wiring trivial.
 */

import { jsonToPayload, ExpirationTime } from "@arkiv-network/sdk/utils";
import { singleCreate } from "../../lib/batch-writer";
import { ENTITY_TYPE, REINFORCEMENT } from "../../constants";

const POLL_INTERVAL_MS = 60_000;

/**
 * Low-information observations. The point is that they're *plausible* but
 * never specific enough to be cited as a decision input — so the Darwinian
 * engine never extends them and they decay.
 */
const NOISE_OBSERVATIONS: readonly string[] = [
  "market sentiment feels mixed today",
  "the chart looks bullish on the 5m",
  "twitter is talking about something",
  "gas is high again",
  "this token name sounds funny",
  "saw a green candle, then a red one",
  "someone in a discord said wagmi",
];

export interface AmnesicAgentHandle {
  stop: () => void;
  getWriteCount: () => number;
}

export function start(opts?: {
  intervalMs?: number;
  onLog?: (msg: string) => void;
}): AmnesicAgentHandle {
  const log = opts?.onLog ?? (() => {});
  const interval = opts?.intervalMs ?? POLL_INTERVAL_MS;
  let stopped = false;
  let writeCount = 0;
  let idx = 0;

  const tick = async () => {
    if (stopped) return;
    const noiseIdx = idx % NOISE_OBSERVATIONS.length;
    const note =
      NOISE_OBSERVATIONS[noiseIdx] ?? "(no observation)";
    idx++;
    try {
      const { entityKey, txHash } = await singleCreate({
        payload: jsonToPayload({
          note,
          source: "amnesic-agent",
          createdAt: Date.now(),
        }),
        contentType: "application/json",
        attributes: [
          { key: "entityType", value: ENTITY_TYPE.OBSERVATION },
          { key: "source", value: "amnesic-agent" },
          { key: "qualityHint", value: "low" },
        ],
        expiresInSeconds: ExpirationTime.fromSeconds(
          REINFORCEMENT.initialWorkingSeconds,
        ),
      });
      writeCount++;
      log(
        `[amnesic-agent] wrote noise entity=${entityKey} tx=${txHash} ` +
          `(will decay in ${REINFORCEMENT.initialWorkingSeconds / 60} min)`,
      );
    } catch (err) {
      console.error("[amnesic-agent] write failed:", err);
    }
  };

  void tick();
  const handle = setInterval(() => {
    void tick();
  }, interval);

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(handle);
      log("[amnesic-agent] stopped");
    },
    getWriteCount: () => writeCount,
  };
}
