"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import DecayReceipt from "./components/DecayReceipt";
import type { DecayTimelineResponse } from "@/src/server/decay-timeline";

/**
 * /decay/<entityKey> — the Decay Receipt page. Reads the entity key from the
 * route, fetches the lease timeline, and renders the curve. The API is a query
 * param (/api/decay/timeline?entityKey=…) because the dispatch router is
 * exact-string match, not path-param.
 */
export default function DecayReceiptPage() {
  const params = useParams<{ entityKey: string }>();
  const entityKey = Array.isArray(params?.entityKey) ? params.entityKey[0] : params?.entityKey;
  const [data, setData] = useState<DecayTimelineResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!entityKey) return;
    let alive = true;
    setData(null);
    setError(null);
    fetch(`/api/decay/timeline?entityKey=${encodeURIComponent(entityKey)}`)
      .then(async (r) => {
        // Robust parse: a non-JSON 5xx (proxy/HTML) must surface the status, not a
        // cryptic "Unexpected token" from r.json().
        const text = await r.text();
        let j: (DecayTimelineResponse & { error?: string }) | null = null;
        try {
          j = text ? (JSON.parse(text) as DecayTimelineResponse & { error?: string }) : null;
        } catch {
          /* non-JSON body */
        }
        if (!r.ok || !j) throw new Error(j?.error ?? `${r.status} ${r.statusText}`);
        if (alive) setData(j);
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [entityKey]);

  return (
    <main style={{ maxWidth: 800, margin: "0 auto", padding: "48px 24px", color: "#e8e8e8" }}>
      <h1 className="mono" style={{ fontSize: 18, marginBottom: 4 }}>Decay Receipt</h1>
      <p className="mono" style={{ fontSize: 13, color: "#8a8f98", marginBottom: 24 }}>
        One memory&apos;s lease over its life — climbs when cited, decays on neglect, evicts for
        free on Arkiv. Useful memory earns its keep.
      </p>
      {error ? (
        <p className="mono" style={{ color: "#e5484d" }}>Could not load timeline: {error}</p>
      ) : !data ? (
        <p className="mono" style={{ color: "#8a8f98" }}>Loading…</p>
      ) : (
        <DecayReceipt data={data} />
      )}
    </main>
  );
}
