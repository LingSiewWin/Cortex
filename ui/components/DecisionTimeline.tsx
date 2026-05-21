/**
 * Cortex — Decision Timeline (Phase 15).
 *
 * Replaces the flat Decision Log list with a vertical timeline. Each act()
 * decision is a blue dot (cold tier — decisions ARE cryptographic anchors)
 * connected to the next by a subtle vertical line. The semantic action
 * (sans-serif, bold) sits next to the dot; below it, mono metadata: block
 * number, citation count, and the truncated cited entity keys (clickable to
 * inspect).
 */

import type { DecisionRecord, Hex } from "../types";
import { truncateAddress } from "../format";

interface Props {
  decisions: DecisionRecord[];
  onInspectCitation: (entityKey: Hex) => void;
}

export function DecisionTimeline({ decisions, onInspectCitation }: Props) {
  if (decisions.length === 0) {
    return (
      <div className="section">
        <div className="section-title">Decision timeline</div>
        <div className="card">
          <div className="empty mono">// no act() decisions yet</div>
        </div>
      </div>
    );
  }

  return (
    <div className="section">
      <div className="section-title">Decision timeline</div>
      <div className="card">
        <div className="timeline">
          {decisions.slice(0, 20).map((d, i) => {
            const isLast = i === Math.min(decisions.length, 20) - 1;
            return (
              <div key={d.entityKey} className="timeline-entry">
                <div className="timeline-rail">
                  <span className="timeline-dot" aria-hidden />
                  {isLast ? null : <span className="timeline-line" aria-hidden />}
                </div>
                <div className="timeline-body">
                  <div className="timeline-action">{d.action}</div>
                  <div className="timeline-receipts mono">
                    block #{d.blockNumber.toLocaleString()} ·{" "}
                    {d.citedKeys.length}{" "}
                    citation{d.citedKeys.length === 1 ? "" : "s"}
                  </div>
                  {d.citedKeys.length > 0 ? (
                    <div className="timeline-citations mono">
                      {d.citedKeys.map((k, idx) => (
                        // Phase 15 review fix: citedKeys may legitimately
                        // contain duplicates (an act() can cite the same
                        // memory more than once). Composite key prevents
                        // React's duplicate-key warning.
                        <span key={`${k}-${idx}`}>
                          <button
                            type="button"
                            className="timeline-citation"
                            onClick={() => onInspectCitation(k)}
                            title={k}
                          >
                            {truncateAddress(k)}
                          </button>
                          {idx < d.citedKeys.length - 1 ? (
                            <span className="timeline-citation-sep">, </span>
                          ) : null}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
