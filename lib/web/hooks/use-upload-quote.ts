"use client";

import { useCallback, useRef, useState } from "react";
import { useAccount } from "wagmi";
import type { PreparedUploadResponse } from "@/lib/web/types/upload-quote";

export function useUploadQuote() {
  const { address, isConnected } = useAccount();
  const [quoteRes, setQuoteRes] = useState<PreparedUploadResponse | null>(null);
  const [pendingName, setPendingName] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const clearQuote = useCallback(() => {
    abortRef.current?.abort();
    setQuoteRes(null);
    setPendingName(null);
    setError(null);
    setLoading(false);
  }, []);

  const fetchQuote = useCallback(
    async (file: File, caption?: string) => {
      if (!isConnected || !address) {
        setError("Connect wallet first.");
        return null;
      }
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setLoading(true);
      setError(null);
      setPendingName(file.name);
      setQuoteRes(null);

      try {
        const body = new FormData();
        body.set("file", file);
        if (caption?.trim()) body.set("caption", caption.trim());
        const url = `/api/store-file/prepare?owner=${encodeURIComponent(address)}`;
        const res = await fetch(url, { method: "POST", body, signal: ctrl.signal });
        const json = (await res.json()) as PreparedUploadResponse & { error?: string };
        if (!res.ok) throw new Error(json.error ?? res.statusText);
        if (ctrl.signal.aborted) return null;
        setQuoteRes(json);
        return json;
      } catch (e) {
        if (ctrl.signal.aborted) return null;
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        return null;
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    },
    [address, isConnected],
  );

  return {
    quote: quoteRes?.quote ?? null,
    prepared: quoteRes,
    pendingName,
    loading,
    error,
    fetchQuote,
    clearQuote,
  };
}
