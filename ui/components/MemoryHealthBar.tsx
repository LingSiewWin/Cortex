import type { MemorySummary } from "../types";
import { formatRemaining, tierLabel, truncateAddress } from "../format";

interface Props {
  memory: MemorySummary;
  onInspect?: (memory: MemorySummary) => void;
}

export function MemoryHealthBar({ memory, onInspect }: Props) {
  const pct = Math.max(2, Math.round(memory.remainingRatio * 100));
  // Rule-tier bars dominate visually because their lifespan is enormous; we
  // already clamp to 0..1 on the server. Working bars decay visibly because
  // remainingSeconds / 1h drops quickly.
  return (
    <div
      className="bar-row"
      role={onInspect ? "button" : undefined}
      tabIndex={onInspect ? 0 : -1}
      onClick={onInspect ? () => onInspect(memory) : undefined}
      onKeyDown={
        onInspect
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onInspect(memory);
              }
            }
          : undefined
      }
      style={{ cursor: onInspect ? "pointer" : "default" }}
      title={`${tierLabel(memory.tier)} memory ${truncateAddress(memory.entityKey)}`}
    >
      <div className="tier">{tierLabel(memory.tier)}</div>
      <div className={`bar ${memory.tier}`}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <div className="remaining">{formatRemaining(memory.remainingSeconds)}</div>
    </div>
  );
}
