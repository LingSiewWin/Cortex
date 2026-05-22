/**
 * Cortex — Arkiv RPC ticker (Phase 16).
 *
 * The "watch the chain talk" surface. Subscribes to `arkiv.rpc.call` on the
 * spine and shows the last 8 calls — method, byte size, latency, tx link.
 * This is what closes the surface-vs-substance gap: a judge sees real Arkiv
 * traffic happening live, not a static dashboard reading a mirror.
 */

import { useSSE } from "../hooks/useSSE";

const EXPLORER = "https://explorer.braga.hoodi.arkiv.network";
const MAX_ROWS = 8;

export function RPCTicker() {
  const events = useSSE(["arkiv.rpc.call"]);
  const rows = events
    .filter((e) => e.event.type === "arkiv.rpc.call")
    .slice(-MAX_ROWS)
    .reverse();

  return (
    <div className="rpc-ticker">
      <div className="rpc-ticker-head">
        <span>Arkiv RPC</span>
        <span className="rpc-ticker-live">live</span>
      </div>
      {rows.length === 0 ? (
        <div className="rpc-empty mono">// waiting for chain activity…</div>
      ) : (
        <div className="rpc-rows">
          {rows.map((ev) => {
            const e = ev.event;
            if (e.type !== "arkiv.rpc.call") return null;
            return (
              <div key={ev.id} className={`rpc-row${e.ok ? "" : " rpc-row-err"}`}>
                <span className="rpc-method mono">{e.method}</span>
                <span className="rpc-bytes mono">{e.byteSize}B</span>
                <span className="rpc-ms mono">{e.ms.toFixed(0)}ms</span>
                {e.txHash ? (
                  <a
                    className="rpc-tx mono"
                    href={`${EXPLORER}/tx/${e.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                    title={e.txHash}
                  >
                    {e.txHash.slice(0, 8)}…
                  </a>
                ) : (
                  <span className="rpc-tx muted">read</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
