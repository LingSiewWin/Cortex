/**
 * Cortex — useTopology.
 *
 * Fetches the Mapper graph from `GET /api/topology` on mount, then DEBOUNCED-
 * refetches (~1.5s trailing) whenever a memory.created / memory.cited /
 * memory.evicted event arrives over the SSE bus. The structural graph (node
 * positions, clusters, edges) is recomputed server-side; between recomputes the
 * `useFrame` loop animates the existing field from the live event store, so we
 * don't refetch on every frame and we don't setState per event.
 *
 * Returns a STABLE graph reference between refetches so consumers that diff on
 * identity (graphStore.syncFromGraph) only resync when the structure changes.
 */

import { useEffect, useRef, useState } from "react";
import { useSSE } from "../../hooks/useSSE";
import { EMPTY_GRAPH, type TopologyGraph } from "./types";

const TOPOLOGY_URL = "/api/topology";
const REFETCH_DEBOUNCE_MS = 1500;
const REFETCH_DEBOUNCE_CREATED_MS = 400;
/** Events that change graph *structure* (warrant a recompute + refetch). */
const STRUCTURAL_EVENTS = [
  "memory.created",
  "memory.cited",
  "memory.evicted",
] as const;

export interface UseTopologyResult {
  graph: TopologyGraph;
  loading: boolean;
  error: string | null;
}

function isTopologyGraph(v: unknown): v is TopologyGraph {
  if (typeof v !== "object" || v === null) return false;
  const g = v as Record<string, unknown>;
  return Array.isArray(g.nodes) && Array.isArray(g.edges);
}

export function useTopology(): UseTopologyResult {
  const [graph, setGraph] = useState<TopologyGraph>(EMPTY_GRAPH);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // SSE: only the structural events trigger a refetch. The cite/evict
  // ANIMATIONS are handled in the render loop via graphStore — this is purely
  // "the structure may have changed, fetch the authoritative layout".
  const structural = useSSE(STRUCTURAL_EVENTS);
  const lastSeenId = useRef<string | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  const fetchGraph = useRef<() => void>(() => {});
  fetchGraph.current = () => {
    inFlight.current?.abort();
    const ctrl = new AbortController();
    inFlight.current = ctrl;
    fetch(TOPOLOGY_URL, { signal: ctrl.signal, headers: { accept: "application/json" } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`topology ${res.status}`);
        const json: unknown = await res.json();
        if (!isTopologyGraph(json)) throw new Error("malformed topology payload");
        return json;
      })
      .then((g) => {
        if (!mounted.current || ctrl.signal.aborted) return;
        setGraph(g);
        setError(null);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted || !mounted.current) return;
        // Keep the last good graph on screen; surface the error for the
        // empty-state copy only when we have nothing to show.
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
  };

  // Initial fetch on mount.
  useEffect(() => {
    mounted.current = true;
    fetchGraph.current();
    return () => {
      mounted.current = false;
      inFlight.current?.abort();
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, []);

  // Debounced refetch on the trailing edge of a burst of structural events.
  useEffect(() => {
    if (structural.length === 0) return;
    const newest = structural[structural.length - 1];
    const newestId = newest?.id ?? null;
    if (newestId === lastSeenId.current) return; // no NEW structural event
    lastSeenId.current = newestId;

    const delay =
      newest?.event.type === "memory.created"
        ? REFETCH_DEBOUNCE_CREATED_MS
        : REFETCH_DEBOUNCE_MS;

    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      fetchGraph.current();
    }, delay);
  }, [structural]);

  return { graph, loading, error };
}
