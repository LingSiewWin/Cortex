/**
 * Cortex — RaBitQ Playground.
 *
 * Two interactive panels on /console that make the compression algorithm
 * visible:
 *
 *   1. Encoder Playground — paste a sentence, see the raw 6,144-byte fp32
 *      embedding shrink to a 198-byte RaBitQ pack. We render the hex bytes
 *      side-by-side and report encode latency + the unbiased self-IP estimate
 *      (which should round to ~1.0 — a live sanity check on the math).
 *
 *   2. Recall Playground — paste a query, see the top-k memory hits ranked by
 *      the unbiased inner-product estimator against the compressed payload
 *      stored in the SQLite mirror. This calls the EXACT same `recall()` the
 *      agent uses (src/darwinian/recall.ts) — proving compressed memories are
 *      genuinely retrievable, not just "stored".
 *
 * State is local to this component; both panels manage their own fetch
 * lifecycle. The `onInspectKey` prop lets the parent open the existing
 * memory-detail modal when a recall hit is clicked.
 */

import { useCallback, useState } from "react";
import type { Hex } from "../types";

interface EncodeResponse {
  rawEmbeddingLen: number;
  rawFirstBytes: string;
  packedBytes: string;
  packLength: number;
  encodeTimeMs: number;
  normFp16: number;
  alignFp16: number;
  selfInnerProduct: number;
  compressionRatio: number;
}

interface RecallHit {
  entityKey: Hex;
  entityType: "observation" | "episode" | "rule" | "document";
  score: number;
  expiresAtBlock: number;
  payloadPreview?: string;
  /** Full text when the hit is a decrypted document (e.g. README upload). */
  text?: string;
  attributes: { key: string; value: string | number }[];
}

interface RecallResponse {
  hits: RecallHit[];
}

interface RaBitQPlaygroundProps {
  /** Called when a recall hit's "Open in inspector" link is clicked. */
  onInspectKey?: (key: Hex) => void;
}

/**
 * Render a long hex blob as fixed-width 16-byte rows (32 hex chars + spaces).
 * Strips the leading "0x" if present.
 */
function HexBlock({ hex }: { hex: string }) {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const rows: string[] = [];
  for (let i = 0; i < clean.length; i += 32) {
    rows.push(clean.slice(i, i + 32));
  }
  return (
    <div className="byte-grid">
      {rows.map((row, idx) => {
        // Insert a space every 2 chars so byte boundaries are visible.
        const formatted = row.match(/.{1,2}/g)?.join(" ") ?? row;
        return (
          <div className="byte-row" key={idx}>
            <span className="byte-offset">
              {(idx * 16).toString(16).padStart(4, "0")}
            </span>
            <span className="byte-hex">{formatted}</span>
          </div>
        );
      })}
    </div>
  );
}

function truncateKey(key: string): string {
  if (key.length <= 14) return key;
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

function EncoderPanel() {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EncodeResponse | null>(null);

  const submit = useCallback(async () => {
    if (!text.trim() || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/playground/encode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.trim() }),
      });
      const json = (await res.json()) as EncodeResponse | { error?: string };
      if (!res.ok) {
        throw new Error(
          (json as { error?: string }).error ?? `HTTP ${res.status}`,
        );
      }
      setResult(json as EncodeResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, [text, loading]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void submit();
      }
    },
    [submit],
  );

  return (
    <div className="card playground-card">
      <div className="playground-input-row">
        <input
          type="text"
          className="playground-input"
          placeholder="paste any sentence"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={loading}
        />
        <button
          type="button"
          className="primary"
          onClick={() => void submit()}
          disabled={loading || !text.trim()}
        >
          {loading ? "Encoding…" : "Encode"}
        </button>
      </div>

      {error ? (
        <div className="playground-error" role="alert">
          {error}
        </div>
      ) : null}

      {result ? (
        <div className="playground-result">
          <div className="playground-cols">
            <div className="playground-col">
              <div className="playground-col-head">
                <span className="tag muted">Raw fp32 embedding</span>
                <span className="muted">
                  {result.rawEmbeddingLen.toLocaleString()} bytes
                </span>
              </div>
              <HexBlock hex={result.rawFirstBytes} />
              <div className="playground-col-foot muted">
                … ({(result.rawEmbeddingLen - 32).toLocaleString()} more bytes)
              </div>
            </div>

            <div className="playground-col">
              <div className="playground-col-head">
                <span className="tag">RaBitQ pack</span>
                <span className="muted">{result.packLength} bytes</span>
              </div>
              <HexBlock hex={result.packedBytes} />
              <div className="playground-col-foot muted">
                full 198-byte pack
              </div>
            </div>
          </div>

          <div className="playground-stats">
            <div className="playground-stat">
              <div className="label">Compression</div>
              <div className="value">{result.compressionRatio.toFixed(1)}×</div>
            </div>
            <div className="playground-stat">
              <div className="label">Encode latency</div>
              <div className="value">{result.encodeTimeMs.toFixed(2)} ms</div>
            </div>
            <div className="playground-stat">
              <div className="label">Self inner-product</div>
              <div className="value">
                {result.selfInnerProduct.toFixed(4)}
              </div>
              <div className="sub muted">≈ ‖vec‖² · sanity check</div>
            </div>
            <div className="playground-stat">
              <div className="label">‖vec‖ (fp16)</div>
              <div className="value">{result.normFp16.toFixed(4)}</div>
            </div>
            <div className="playground-stat">
              <div className="label">⟨ō, o⟩ (fp16)</div>
              <div className="value">{result.alignFp16.toFixed(4)}</div>
              <div className="sub muted">estimator denominator</div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function RecallPanel({ onInspectKey }: { onInspectKey?: (k: Hex) => void }) {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hits, setHits] = useState<RecallHit[] | null>(null);

  const submit = useCallback(async () => {
    if (!text.trim() || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/playground/recall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: text.trim(), k: 5 }),
      });
      const json = (await res.json()) as
        | RecallResponse
        | { error?: string };
      if (!res.ok) {
        throw new Error(
          (json as { error?: string }).error ?? `HTTP ${res.status}`,
        );
      }
      setHits((json as RecallResponse).hits);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setHits(null);
    } finally {
      setLoading(false);
    }
  }, [text, loading]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void submit();
      }
    },
    [submit],
  );

  return (
    <div className="card playground-card">
      <div className="playground-input-row">
        <input
          type="text"
          className="playground-input"
          placeholder="ask the memory store anything"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={loading}
        />
        <button
          type="button"
          className="primary"
          onClick={() => void submit()}
          disabled={loading || !text.trim()}
        >
          {loading ? "Searching…" : "Recall"}
        </button>
      </div>

      {error ? (
        <div className="playground-error" role="alert">
          {error}
        </div>
      ) : null}

      {hits !== null ? (
        hits.length === 0 ? (
          <div className="empty">
            No matches in your mirror yet. Upload a file on /console or run{" "}
            <code>bun run mirror</code> to sync Braga.
          </div>
        ) : (
          <div className="playground-hits">
            {hits.map((h) => (
              <div className="playground-hit" key={h.entityKey}>
                <div className="playground-hit-head">
                  <span className="tag muted">{h.entityType}</span>
                  <span className="mono">{truncateKey(h.entityKey)}</span>
                  <span className="playground-hit-score">
                    score {h.score.toFixed(4)}
                  </span>
                </div>
                {h.text ? (
                  <div className="playground-hit-preview playground-hit-text">
                    {h.text.length > 400 ? `${h.text.slice(0, 400)}…` : h.text}
                  </div>
                ) : h.payloadPreview ? (
                  <div className="playground-hit-preview">
                    {h.payloadPreview}
                  </div>
                ) : null}
                {onInspectKey ? (
                  <button
                    type="button"
                    className="ghost playground-hit-inspect"
                    onClick={() => onInspectKey(h.entityKey)}
                  >
                    Open in inspector →
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}

export function RaBitQPlayground({ onInspectKey }: RaBitQPlaygroundProps = {}) {
  return (
    <>
      <div className="section playground-section">
        <div className="section-title">
          RaBitQ Encoder · paste text, see the compression
        </div>
        <EncoderPanel />
      </div>

      <div className="section playground-section">
        <div className="section-title">Recall Playground · semantic search</div>
        <div className="section-hint">
          Wallet uploads are <code>document</code> entities (full README text). Agent seeds
          are <code>observation</code> (~198 B fingerprints). Open the hit whose type matches
          what you stored — or use <strong>Open in inspector</strong> on the upload success line.
        </div>
        <RecallPanel onInspectKey={onInspectKey} />
      </div>
    </>
  );
}
