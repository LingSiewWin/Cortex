"use client";

import type { DecayTimelineResponse, DecayPoint } from "@/src/server/decay-timeline";

/**
 * Decay Receipt — a memory's lease over its life, as an inline-SVG step curve.
 * No charting dependency. Solid = anchored on-chain; dashed = committed-local
 * ("queued") or the synthetic projected-eviction downslope. The curve climbs on
 * each citation and decays to zero on neglect — the Darwinian story, drawn.
 */

const ACCENT = "#ff5a00";
const AMBER = "#f0b429";
const DASH = "#8a8f98";
const W = 720;
const H = 280;
const PAD = { top: 28, right: 24, bottom: 56, left: 64 };

function fmtLease(s: number): string {
  if (s <= 0) return "0";
  if (s >= 86_400) return `${(s / 86_400).toFixed(1)}d`;
  if (s >= 3_600) return `${Math.round(s / 3_600)}h`;
  return `${Math.max(1, Math.round(s / 60))}m`;
}

export default function DecayReceipt({ data }: { data: DecayTimelineResponse }) {
  const pts = data.points;
  if (pts.length === 0) {
    return (
      <div className="decay-receipt-empty mono" style={{ padding: 24, color: DASH }}>
        {data.note}
      </div>
    );
  }

  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const maxLease = Math.max(...pts.map((p) => p.leaseSeconds), 1);
  // Index-based x so real events stay readable even when the synthetic eviction
  // point projects far into the future (time-based x would bunch them at the left).
  const x = (i: number) => PAD.left + (pts.length === 1 ? innerW / 2 : (i / (pts.length - 1)) * innerW);
  const y = (lease: number) => PAD.top + innerH - (lease / maxLease) * innerH;

  const dotColor = (p: DecayPoint) =>
    p.source === "onchain" ? ACCENT : p.source === "projected" ? AMBER : DASH;

  // Split each step into a HOLD (horizontal, coloured by where it comes FROM) and
  // a JUMP (vertical, coloured by where it goes TO). Keying solidity off the hold's
  // own provenance means the climb OUT of a real on-chain point renders SOLID — so
  // the "solid = anchored, dashed = projected" story is visible in the live
  // created→cite demo (verify-debate MUST-FIX #1). The neglect segment into a
  // synthetic point is a diagonal SLOPE (gradual decay), not a hold-then-cliff.
  interface Seg {
    d: string;
    stroke: string;
    dashed: boolean;
  }
  function segments(): Seg[] {
    const segs: Seg[] = [];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      if (b.source === "synthetic") {
        // projected neglect: slope down from a's lease to zero.
        segs.push({
          d: `M ${x(i - 1)} ${y(a.leaseSeconds)} L ${x(i)} ${y(b.leaseSeconds)}`,
          stroke: DASH,
          dashed: true,
        });
        continue;
      }
      segs.push({
        d: `M ${x(i - 1)} ${y(a.leaseSeconds)} L ${x(i)} ${y(a.leaseSeconds)}`,
        stroke: dotColor(a),
        dashed: a.source !== "onchain",
      });
      segs.push({
        d: `M ${x(i)} ${y(a.leaseSeconds)} L ${x(i)} ${y(b.leaseSeconds)}`,
        stroke: dotColor(b),
        dashed: b.source !== "onchain",
      });
    }
    return segs;
  }

  return (
    <div className="decay-receipt">
      <div className="decay-receipt-head" style={{ marginBottom: 8 }}>
        <span className="mono" style={{ color: ACCENT, fontWeight: 600 }}>{data.cortexId}</span>{" "}
        <span className="mono" style={{ color: DASH }}>
          · {data.state}
          {data.estimated ? " · projection (est.)" : " · on-chain"}
        </span>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Memory lease decay curve">
        {/* y-axis ticks */}
        {[0, 0.5, 1].map((f) => {
          const yy = PAD.top + innerH - f * innerH;
          return (
            <g key={f}>
              <line x1={PAD.left} y1={yy} x2={W - PAD.right} y2={yy} stroke="#2a2a2a" strokeWidth={1} />
              <text x={PAD.left - 8} y={yy + 4} textAnchor="end" fontSize={11} fill={DASH} className="mono">
                {fmtLease(maxLease * f)}
              </text>
            </g>
          );
        })}

        {/* step curve */}
        {segments().map((s, i) => (
          <path
            key={i}
            d={s.d}
            fill="none"
            stroke={s.stroke}
            strokeWidth={2}
            strokeDasharray={s.dashed ? "6 5" : undefined}
          />
        ))}

        {/* points */}
        {pts.map((p, i) => (
          <g key={i}>
            <circle cx={x(i)} cy={y(p.leaseSeconds)} r={4} fill={dotColor(p)} />
            {p.eventType === "evicted" || p.eventType === "neglect" ? (
              <circle cx={x(i)} cy={y(p.leaseSeconds)} r={7} fill="none" stroke="#e5484d" strokeWidth={1.5} />
            ) : null}
          </g>
        ))}
      </svg>

      {/* legend / step labels */}
      <ol className="decay-receipt-steps mono" style={{ marginTop: 8, fontSize: 12, lineHeight: 1.6, color: "#c9ccd1" }}>
        {pts.map((p, i) => (
          <li key={i}>
            <span style={{ color: dotColor(p) }}>●</span> {p.label}
            {p.txHash ? (
              <>
                {" · "}
                <a
                  href={`https://explorer.braga.hoodi.arkiv.network/tx/${p.txHash}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: ACCENT }}
                >
                  tx ↗
                </a>
              </>
            ) : null}
          </li>
        ))}
      </ol>
      <p className="mono" style={{ marginTop: 6, fontSize: 11, color: DASH }}>{data.note}</p>
    </div>
  );
}
