import type { DecisionRecord, Hex } from "../types";
import { truncateAddress } from "../format";

interface Props {
  decision: DecisionRecord;
  onInspectCitation?: (entityKey: Hex) => void;
}

export function DecisionRow({ decision, onInspectCitation }: Props) {
  return (
    <div className="decision">
      <div className="head">
        <div className="action">{decision.action}</div>
        <div className="meta">block #{decision.blockNumber.toLocaleString()}</div>
      </div>
      <div className="chips" aria-label="cited memories">
        {decision.citedKeys.length === 0 ? (
          <span className="meta">no citations</span>
        ) : (
          decision.citedKeys.map((k) => (
            <button
              key={k}
              type="button"
              className="chip"
              title={k}
              onClick={onInspectCitation ? () => onInspectCitation(k) : undefined}
            >
              {truncateAddress(k)}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
