/**
 * Cortex — RaBitQ tile (Phase 16).
 *
 * Promotes the RaBitQ compression proof out of the dev-mode playground into
 * the ambient surface. Subscribes to `rabitq.encoded` and shows the live
 * dim→bytes ratio + a sparkline of recent encode latencies, so a judge sees
 * the 31× compression actually happening per query, not just claimed.
 */

import { useMemo } from "react";
import { useSSE } from "../hooks/useSSE";
import type { EventOf } from "../types";

const SPARK_N = 24;

export function RaBitQTile() {
  const events = useSSE(["rabitq.encoded"]);
  const encs = useMemo(
    () =>
      events
        .map((e) => e.event)
        .filter((e): e is EventOf<"rabitq.encoded"> => e.type === "rabitq.encoded"),
    [events],
  );
  const latest = encs.length > 0 ? encs[encs.length - 1]! : null;
  const spark = encs.slice(-SPARK_N);
  const maxMs = Math.max(0.001, ...spark.map((e) => e.ms));

  return (
    <div className="rabitq-tile">
      <div className="rabitq-head">
        <span>RaBitQ compression</span>
        <span className="rabitq-live">live</span>
      </div>
      {!latest ? (
        <div className="rabitq-empty mono">// no encodings yet</div>
      ) : (
        <>
          <div className="rabitq-big mono">
            {latest.dim}d → {latest.bytes}B
          </div>
          <div className="rabitq-ratio">
            <span className="rabitq-ratio-x mono">{latest.ratio.toFixed(0)}×</span>
            <span className="muted"> · last {latest.ms.toFixed(1)}ms</span>
          </div>
          <div className="rabitq-count muted">
            {encs.length.toLocaleString()} encoding{encs.length === 1 ? "" : "s"} this session
          </div>
          <div className="rabitq-spark" aria-hidden>
            {spark.map((e, i) => (
              <span
                key={i}
                className="rabitq-spark-bar"
                style={{ height: `${Math.max(8, (e.ms / maxMs) * 100)}%` }}
                title={`${e.ms.toFixed(1)}ms`}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
