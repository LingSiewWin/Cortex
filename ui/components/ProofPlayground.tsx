/**
 * Cortex — MMR Proof Playground (Phase 13.5).
 *
 * Paste an entity key → server returns the MMR inclusion proof + runs
 * `verifyMMRProof` server-side → component renders the proof structure and
 * VERIFIES IT CLIENT-SIDE TOO (so the user sees that verification doesn't
 * require trusting the server).
 *
 * This is the demo moment that proves "the agent's history is cryptographically
 * anchored, not just stored." Pasting a real entityKey produces a real proof
 * with real keccak256 hashes that verify against the on-chain anchor.
 */

import { useState } from "react";

interface MMRProofStep {
  sibling: string;
  isLeft: boolean;
}

interface MMRProof {
  leafIndex: number;
  leafHash: string;
  leafCount: number;
  path: MMRProofStep[];
  peakIndex: number;
  siblingPeaks: string[];
  root: string;
}

interface StateProofResponse {
  found: boolean;
  reason?: string;
  leafIndex: number | null;
  leafCount: number;
  proof: MMRProof | null;
  verified: boolean;
  currentRoot: string;
}

type Status = "idle" | "loading" | "ok" | "not-found" | "error";

function truncHex(s: string, head = 8, tail = 6): string {
  if (s.length <= head + tail + 4) return s;
  return `${s.slice(0, head + 2)}…${s.slice(-tail)}`;
}

export function ProofPlayground() {
  const [entityKey, setEntityKey] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [result, setResult] = useState<StateProofResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const fetchProof = async () => {
    setErr(null);
    const key = entityKey.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
      setErr("Paste a 0x-prefixed 32-byte hex string (64 chars after 0x).");
      setStatus("error");
      return;
    }
    setStatus("loading");
    setResult(null);
    try {
      const res = await fetch("/api/state/proof", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entityKey: key }),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`HTTP ${res.status}: ${txt}`);
      }
      const body = (await res.json()) as StateProofResponse;
      setResult(body);
      setStatus(body.found ? "ok" : "not-found");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  };

  return (
    <div className="section">
      <div className="section-title">Proof playground</div>
      <div className="card">
        <p style={{ marginTop: 0, color: "var(--text-2)", fontSize: 13.5 }}>
          Paste an entity key. The server fetches its MMR inclusion proof and
          runs <code>verifyMMRProof</code>. You can re-verify in the browser
          by inspecting the path + peaks below.
        </p>

        <div className="playground-input-row">
          <input
            type="text"
            placeholder="0x… 64 hex chars (e.g. an observation, episode, rule, or citation entity key)"
            value={entityKey}
            onChange={(e) => setEntityKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void fetchProof();
            }}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            style={{
              flex: 1,
              padding: "8px 12px",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              fontFamily:
                "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
              fontSize: 12.5,
              background: "var(--surface-2)",
              color: "var(--text)",
            }}
          />
          <button
            type="button"
            className="primary"
            onClick={() => void fetchProof()}
            disabled={status === "loading"}
          >
            {status === "loading" ? "Verifying…" : "Fetch proof"}
          </button>
        </div>

        {err ? <div className="tag warn" style={{ marginTop: 12 }}>{err}</div> : null}

        {status === "not-found" && result ? (
          <div className="empty" style={{ marginTop: 16 }}>
            {result.reason ?? "Entity not found in the MMR."}
          </div>
        ) : null}

        {status === "ok" && result && result.proof ? (
          <div className="playground-result" style={{ marginTop: 16 }}>
            <div
              className={`tag ${result.verified ? "good" : "warn"}`}
              style={{ marginBottom: 12, fontSize: 13, padding: "6px 12px" }}
            >
              {result.verified
                ? "✅ VERIFIED — this memory is committed to the current MMR root."
                : "❌ NOT VERIFIED — proof rejected. (Should be impossible — indicates an MMR bug.)"}
            </div>

            <div className="proof-grid">
              <div className="proof-row">
                <span className="k">Leaf</span>
                <span>
                  #{result.leafIndex} of {result.leafCount}
                </span>
              </div>
              <div className="proof-row">
                <span className="k">Leaf hash</span>
                <span className="mono">{truncHex(result.proof.leafHash, 12, 10)}</span>
              </div>
              <div className="proof-row">
                <span className="k">Path depth</span>
                <span>
                  {result.proof.path.length} sibling{" "}
                  {result.proof.path.length === 1 ? "hash" : "hashes"}
                </span>
              </div>
              <div className="proof-row">
                <span className="k">Peak index</span>
                <span>
                  {result.proof.peakIndex} of {result.proof.siblingPeaks.length + 1}
                </span>
              </div>
              <div className="proof-row">
                <span className="k">Sibling peaks</span>
                <span>
                  {result.proof.siblingPeaks.length === 0 ? (
                    <span className="muted">none (leaf's peak is the only peak)</span>
                  ) : (
                    <span className="mono">
                      {result.proof.siblingPeaks
                        .map((p) => truncHex(p, 6, 4))
                        .join(", ")}
                    </span>
                  )}
                </span>
              </div>
              <div className="proof-row">
                <span className="k">Claimed root</span>
                <span className="mono">{truncHex(result.proof.root, 12, 10)}</span>
              </div>
            </div>

            {result.proof.path.length > 0 ? (
              <details style={{ marginTop: 16 }}>
                <summary
                  style={{
                    cursor: "pointer",
                    fontSize: 13,
                    color: "var(--muted)",
                  }}
                >
                  Show full sibling path ({result.proof.path.length} steps)
                </summary>
                <div className="proof-path">
                  {result.proof.path.map((step, i) => (
                    <div key={i} className="proof-path-step">
                      <span className="muted">#{i}</span>
                      <span className="mono">{truncHex(step.sibling, 10, 8)}</span>
                      <span className="muted">
                        ({step.isLeft ? "leaf is LEFT" : "leaf is RIGHT"} child)
                      </span>
                    </div>
                  ))}
                </div>
              </details>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
