"use client";

import type { UploadQuote } from "@/lib/web/types/upload-quote";

function formatUploadBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function formatByteSeconds(s: string): string {
  try {
    const n = BigInt(s);
    if (n < 1_000_000n) return `${n.toLocaleString()} byte·s`;
    if (n < 1_000_000_000_000n) return `${(Number(n) / 1_000_000).toFixed(2)} million byte·s`;
    if (n < 1_000_000_000_000_000n) return `${(Number(n) / 1_000_000_000).toFixed(2)} billion byte·s`;
    return `${(Number(n) / 1_000_000_000_000).toFixed(2)} trillion byte·s`;
  } catch {
    return `${s} byte·s`;
  }
}

export function UploadCostEstimate({
  quote,
  filename,
  loading,
  idleHint,
}: {
  quote: UploadQuote | null;
  filename: string | null;
  loading?: boolean;
  /** Shown when no file selected yet — makes the estimator discoverable. */
  idleHint?: string;
}) {
  if (loading) {
    return (
      <div className="upload-quote upload-quote-loading" role="status">
        <p className="mono">Estimating payload + Braga gas…</p>
      </div>
    );
  }

  if (!quote || !filename) {
    return (
      <div className="upload-quote upload-quote-idle" role="status">
        <p className="upload-quote-title mono">Cost before you sign</p>
        <p className="upload-quote-idle-text">
          {idleHint ??
            "Choose a file or preview a link — you will see sealed payload size, 1-year lease, and estimated GLM before MetaMask opens."}
        </p>
      </div>
    );
  }

  return (
    <div className="upload-quote" role="region" aria-label="Upload cost estimate">
      <p className="upload-quote-title mono">Cost before you sign</p>
      <p className="upload-quote-file">
        <strong>{filename}</strong>
        {quote.binary ? (
          <span className="upload-quote-tag"> · image/binary (hash + caption on-chain)</span>
        ) : (
          <span className="upload-quote-tag"> · text sealed for recall</span>
        )}
      </p>

      <dl className="upload-quote-grid">
        <div>
          <dt>Source file</dt>
          <dd className="mono">{formatUploadBytes(quote.sourceFileBytes)}</dd>
        </div>
        <div>
          <dt>On-chain payload (sealed)</dt>
          <dd className="mono">{formatUploadBytes(quote.sealedPayloadBytes)}</dd>
        </div>
        <div>
          <dt>Initial lease</dt>
          <dd>
            {quote.leaseLabel}
            <span className="upload-quote-sub mono"> · until ~{quote.expiresAbout}</span>
          </dd>
        </div>
        <div>
          <dt>Storage meter</dt>
          <dd className="mono" title="sealed bytes × lease seconds — Arkiv pricing input, not a separate MetaMask charge today">
            {formatByteSeconds(quote.storageByteSeconds)}
          </dd>
        </div>
        <div>
          <dt>MetaMask (tx gas max)</dt>
          <dd className="mono">{quote.walletApprovalGlm}</dd>
        </div>
        {quote.storageEstimateGlm ? (
          <div>
            <dt>Storage (illustrative)</dt>
            <dd className="mono">{quote.storageEstimateGlm}</dd>
          </div>
        ) : null}
        <div className="upload-quote-total">
          <dt>Total estimate</dt>
          <dd className="mono">{quote.totalEstimateGlm}</dd>
        </div>
      </dl>

      <p className="upload-quote-note">{quote.disclaimer}</p>
    </div>
  );
}
