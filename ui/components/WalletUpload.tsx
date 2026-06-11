"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { BragaGasBanner } from "@/lib/web/components/BragaGasBanner";
import { useUploadQuote } from "@/lib/web/hooks/use-upload-quote";
import { useBrowserUpload, type UploadStep } from "@/lib/web/hooks/use-browser-upload";
import { UploadCostEstimate } from "./UploadCostEstimate";

const EXPLORER = "https://explorer.braga.hoodi.arkiv.network";
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_BINARY_BYTES = 25 * 1024 * 1024;

const TEXT_EXT =
  /\.(txt|md|markdown|json|js|jsx|ts|tsx|mjs|cjs|py|go|rs|css|html|htm|yaml|yml|toml|sh|sql|csv|xml|svg)$/i;

function isTextLikeFile(file: File): boolean {
  if (file.type.startsWith("text/")) return true;
  if (file.type === "application/json" || file.type === "application/javascript") return true;
  return TEXT_EXT.test(file.name);
}

function slugFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    const tail = parts.slice(-2).join("-") || u.hostname.replace(/\./g, "-");
    return tail.slice(0, 48) || "link";
  } catch {
    return "link";
  }
}

function noteFileFromLink(url: string, extraCaption?: string): File {
  const lines = [
    "# Cortex memory",
    "",
    `source: ${url}`,
    "",
    "Stored from the Cortex console judge — use recall to find this repo or page again.",
  ];
  if (extraCaption?.trim()) {
    lines.push("", extraCaption.trim());
  }
  const body = lines.join("\n");
  const name = `repo-${slugFromUrl(url)}.md`;
  return new File([body], name, { type: "text/markdown" });
}

const STEP_LABEL: Record<UploadStep, string | null> = {
  idle: null,
  switch: "Switching to Arkiv Braga…",
  adopt: "Sign once to derive your memory key…",
  prepare: "Refreshing cost estimate…",
  sign: "Approve Braga transaction in wallet…",
  done: null,
  error: null,
};

interface WalletUploadProps {
  onStored?: () => void;
  /** Open the memory inspector for a freshly stored entity. */
  onInspectKey?: (key: import("@/ui/types").Hex) => void;
}

export function WalletUpload({ onStored, onInspectKey }: WalletUploadProps) {
  const { isConnected } = useAccount();
  const { upload, step, error, lastTx, lastEntityKey, lastGas, identity } = useBrowserUpload();
  const {
    quote,
    prepared,
    pendingName,
    loading: quoteLoading,
    error: quoteError,
    fetchQuote,
    clearQuote,
  } = useUploadQuote();
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingFileRef = useRef<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [caption, setCaption] = useState("");
  const [linkInput, setLinkInput] = useState("");
  const [localErr, setLocalErr] = useState<string | null>(null);
  const busy = step !== "idle" && step !== "done" && step !== "error";
  const canStore = Boolean(prepared && quote && !quoteLoading && !busy);

  const onFileChosen = useCallback(
    async (file: File) => {
      const binary = !isTextLikeFile(file);
      const maxBytes = binary ? MAX_BINARY_BYTES : MAX_TEXT_BYTES;
      if (file.size > maxBytes) {
        const mb = (maxBytes / (1024 * 1024)).toFixed(0);
        setLocalErr(`File too large — max ${mb}MB for ${binary ? "binary" : "text"} uploads.`);
        clearQuote();
        return;
      }
      setLocalErr(null);
      pendingFileRef.current = file;
      await fetchQuote(file, caption);
    },
    [caption, clearQuote, fetchQuote],
  );

  const onPick = useCallback(
    async (files: FileList | null) => {
      const file = files?.[0];
      if (!file || busy) return;
      if (!isConnected) {
        setLocalErr("Connect wallet first.");
        return;
      }
      await onFileChosen(file);
    },
    [busy, isConnected, onFileChosen],
  );

  const onStoreLink = useCallback(async () => {
    if (busy) return;
    if (!isConnected) {
      setLocalErr("Connect wallet first.");
      return;
    }
    const url = linkInput.trim();
    if (!url) {
      setLocalErr("Paste a repository or page URL.");
      return;
    }
    try {
      new URL(url);
    } catch {
      setLocalErr("Enter a full URL (https://…).");
      return;
    }
    setLocalErr(null);
    const file = noteFileFromLink(url, caption);
    await onFileChosen(file);
  }, [busy, caption, isConnected, linkInput, onFileChosen]);

  const confirmStore = useCallback(async () => {
    const file = pendingFileRef.current;
    if (!file || !prepared) return;
    setLocalErr(null);
    try {
      await upload(file, caption || undefined, { prepared });
      setCaption("");
      setLinkInput("");
      pendingFileRef.current = null;
      clearQuote();
      if (inputRef.current) inputRef.current.value = "";
      onStored?.();
    } catch (e) {
      setLocalErr(e instanceof Error ? e.message : String(e));
    }
  }, [caption, clearQuote, onStored, prepared, upload]);

  useEffect(() => {
    const file = pendingFileRef.current;
    if (!file || !isConnected || busy) return;
    const t = setTimeout(() => {
      void fetchQuote(file, caption);
    }, 500);
    return () => clearTimeout(t);
  }, [caption, busy, fetchQuote, isConnected]);

  const serverBlockers = identity.uploadBlockers;

  return (
    <div className="wallet-upload">
      <p className="wallet-upload-lead">
        Grow the graph with your own memories — upload images, notes, or a repo URL. You will
        see payload size, lease, and estimated GLM <strong>before</strong> MetaMask opens. Your
        wallet signs each Braga write (native GLM gas).
      </p>

      {serverBlockers.length > 0 ? (
        <ul className="wallet-upload-blockers">
          {serverBlockers.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      ) : null}

      <BragaGasBanner />

      <div className="wallet-upload-grid">
        <div
          className={`wallet-upload-drop${dragOver ? " wallet-upload-drop-active" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            void onPick(e.dataTransfer.files);
          }}
        >
          <p className="wallet-upload-section-label mono">File</p>
          <input
            ref={inputRef}
            type="file"
            className="wallet-upload-input"
            accept="image/*,.md,.txt,.json,.pdf,*/*"
            disabled={busy || !isConnected}
            onChange={(e) => void onPick(e.target.files)}
          />
          <button
            type="button"
            className="wallet-upload-btn"
            disabled={busy || !isConnected || serverBlockers.length > 0}
            onClick={() => inputRef.current?.click()}
          >
            {quoteLoading ? "Estimating…" : "Choose file"}
          </button>
          <span className="wallet-upload-hint mono">
            or drop · images ≤25MB · text ≤2MB · estimate before sign
          </span>
        </div>

        <div className="wallet-upload-link">
          <p className="wallet-upload-section-label mono">Repository or link</p>
          <input
            type="url"
            className="wallet-upload-link-input"
            value={linkInput}
            disabled={busy || !isConnected}
            placeholder="https://github.com/you/your-repo"
            onChange={(e) => setLinkInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void onStoreLink();
            }}
          />
          <button
            type="button"
            className="wallet-upload-btn wallet-upload-btn-secondary"
            disabled={busy || !isConnected || serverBlockers.length > 0 || !linkInput.trim()}
            onClick={() => void onStoreLink()}
          >
            {quoteLoading ? "Estimating…" : "Preview link cost"}
          </button>
          <span className="wallet-upload-hint mono">
            Saved as a markdown note · embedded for recall
          </span>
        </div>
      </div>

      <label className="wallet-upload-caption">
        <span className="mono">Caption (optional)</span>
        <input
          type="text"
          value={caption}
          disabled={busy}
          placeholder="e.g. Cortex hackathon repo, architecture diagram…"
          onChange={(e) => setCaption(e.target.value)}
        />
      </label>

      <UploadCostEstimate
        quote={quote}
        filename={pendingName}
        loading={quoteLoading}
        idleHint={
          isConnected
            ? "Choose a file or preview a link — cost estimate appears here before MetaMask."
            : undefined
        }
      />

      {canStore ? (
        <div className="wallet-upload-confirm-row">
          <button
            type="button"
            className="wallet-upload-btn wallet-upload-btn-primary"
            disabled={serverBlockers.length > 0}
            onClick={() => void confirmStore()}
          >
            Store on Arkiv · {quote?.walletApprovalGlm ?? "…"}
          </button>
          <button
            type="button"
            className="wallet-upload-btn wallet-upload-btn-ghost"
            onClick={() => {
              pendingFileRef.current = null;
              clearQuote();
              if (inputRef.current) inputRef.current.value = "";
            }}
          >
            Cancel
          </button>
        </div>
      ) : null}

      {STEP_LABEL[step] ? <p className="wallet-upload-status mono">{STEP_LABEL[step]}</p> : null}

      {lastTx ? (
        <div className="wallet-upload-ok">
          <p className="mono">
            Stored on Arkiv ·{" "}
            <a href={`${EXPLORER}/tx/${lastTx}`} target="_blank" rel="noreferrer">
              tx {lastTx.slice(0, 12)}…
            </a>
            {" · "}
            graph refreshes in a few seconds
          </p>
          {lastGas ? (
            <p className="wallet-upload-gas mono" title="Measured from the on-chain receipt (gasUsed × effectiveGasPrice) — the actual L2 execution fee your wallet paid, not a pre-sign estimate.">
              ⛽ your wallet burned{" "}
              <strong>{Number(lastGas.feeGlm).toFixed(8)} GLM</strong> ·{" "}
              {Number(lastGas.gasUsed).toLocaleString()} gas @ {Number(lastGas.effectiveGasPriceGwei).toFixed(4)} gwei
            </p>
          ) : null}
          {lastEntityKey ? (
            <p className="wallet-upload-entity mono">
              memory key{" "}
              <span title={lastEntityKey}>{lastEntityKey.slice(0, 14)}…</span>
              {onInspectKey ? (
                <>
                  {" · "}
                  <button
                    type="button"
                    className="wallet-upload-inspect-link"
                    onClick={() => onInspectKey(lastEntityKey)}
                  >
                    Open in inspector →
                  </button>
                </>
              ) : null}
            </p>
          ) : null}
          <p className="wallet-upload-ok-hint">
            Text files (.md, .txt) recover full content in the inspector. Images store
            hash + caption only — keep the original file locally.
          </p>
        </div>
      ) : null}
      {error || localErr || quoteError ? (
        <p className="wallet-upload-err">{error ?? localErr ?? quoteError}</p>
      ) : null}
    </div>
  );
}
