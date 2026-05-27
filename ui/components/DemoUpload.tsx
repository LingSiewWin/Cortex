"use client";

import { useCallback, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { useBrowserUpload, type UploadStep } from "@/lib/web/hooks/use-browser-upload";

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

const STEP_LABEL: Record<UploadStep, string | null> = {
  idle: null,
  switch: "Switching to Arkiv Braga…",
  adopt: "Sign once to derive your memory key…",
  prepare: "Embedding file on server…",
  sign: "Approve Braga transaction in wallet…",
  done: null,
  error: null,
};

interface DemoUploadProps {
  onStored?: () => void;
}

export function DemoUpload({ onStored }: DemoUploadProps) {
  const { isConnected } = useAccount();
  const { upload, step, error, lastTx, identity } = useBrowserUpload();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [caption, setCaption] = useState("");
  const [localErr, setLocalErr] = useState<string | null>(null);
  const busy = step !== "idle" && step !== "done" && step !== "error";

  const onPick = useCallback(
    async (files: FileList | null) => {
      const file = files?.[0];
      if (!file || busy) return;
      if (!isConnected) {
        setLocalErr("Connect wallet first.");
        return;
      }

      const binary = !isTextLikeFile(file);
      const maxBytes = binary ? MAX_BINARY_BYTES : MAX_TEXT_BYTES;
      if (file.size > maxBytes) {
        const mb = (maxBytes / (1024 * 1024)).toFixed(0);
        setLocalErr(`File too large — max ${mb}MB for ${binary ? "binary" : "text"} uploads.`);
        return;
      }

      setLocalErr(null);
      try {
        await upload(file, caption);
        setCaption("");
        if (inputRef.current) inputRef.current.value = "";
        onStored?.();
      } catch {
        /* error state set in hook */
      }
    },
    [busy, caption, isConnected, onStored, upload],
  );

  const serverBlockers = identity.uploadBlockers;

  return (
    <div className="demo-upload">
      <p className="demo-upload-lead">
        Upload a note, code file, or image — your wallet signs the Braga write (official Arkiv
        MetaMask flow). Text seals losslessly; images index by sha256 + caption.
      </p>

      {serverBlockers.length > 0 ? (
        <ul className="demo-upload-blockers">
          {serverBlockers.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      ) : null}

      <div
        className={`demo-upload-drop${dragOver ? " demo-upload-drop-active" : ""}`}
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
        <input
          ref={inputRef}
          type="file"
          className="demo-upload-input"
          accept="*/*"
          disabled={busy || !isConnected}
          onChange={(e) => void onPick(e.target.files)}
        />
        <button
          type="button"
          className="demo-upload-btn"
          disabled={busy || !isConnected || serverBlockers.length > 0}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? "Working…" : "Choose file"}
        </button>
        <span className="demo-upload-hint mono">
          or drop · text ≤2MB · images ≤25MB · you pay Braga gas
        </span>
      </div>

      <label className="demo-upload-caption">
        <span className="mono">Caption (optional)</span>
        <input
          type="text"
          value={caption}
          disabled={busy}
          placeholder="What is this file about?"
          onChange={(e) => setCaption(e.target.value)}
        />
      </label>

      {STEP_LABEL[step] ? <p className="demo-upload-status mono">{STEP_LABEL[step]}</p> : null}

      {lastTx ? (
        <p className="demo-upload-ok mono">
          Stored on Arkiv ·{" "}
          <a href={`${EXPLORER}/tx/${lastTx}`} target="_blank" rel="noreferrer">
            {lastTx.slice(0, 12)}…
          </a>
        </p>
      ) : null}
      {error || localErr ? <p className="demo-upload-err">{error ?? localErr}</p> : null}
    </div>
  );
}
