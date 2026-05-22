/**
 * Cortex — useSSE (Phase 16).
 *
 * Single shared EventSource connection to /sse, exposed to React via
 * useSyncExternalStore. One connection per page regardless of how many
 * components subscribe; components filter the snapshot by event type.
 *
 * Reconnect is handled by the browser's native EventSource (server sends
 * `retry: 3000`). On reconnect the browser sends Last-Event-ID and the server
 * replays missed events, so the snapshot self-heals after a blip.
 *
 * Design (research-grounded):
 *   - useSyncExternalStore is the canonical React 19 primitive for external
 *     mutable sources. No third-party SSE-hook library — they obscure the
 *     reconnect semantics we want to keep visible.
 *   - getSnapshot returns a STABLE array reference between events (only
 *     replaced when a new event arrives) so React doesn't infinite-loop.
 */

import { useMemo, useSyncExternalStore } from "react";
import {
  ALL_EVENT_TYPES,
  type DomainEventType,
  type EventOf,
  type SpineEvent,
} from "../types";

const MAX_EVENTS = 500;
const SSE_URL = "/sse";

const EMPTY: SpineEvent[] = [];

type Listener = () => void;

interface SpineStore {
  subscribe(listener: Listener): () => void;
  getSnapshot(): SpineEvent[];
  /** True once the EventSource has opened at least once. */
  getConnected(): boolean;
}

function createSpineStore(): SpineStore {
  let events: SpineEvent[] = EMPTY;
  let connected = false;
  const listeners = new Set<Listener>();
  let es: EventSource | null = null;

  const emit = () => {
    for (const l of listeners) l();
  };

  const handlerFor = (type: DomainEventType) => (e: MessageEvent) => {
    let parsed: SpineEvent["event"];
    try {
      parsed = JSON.parse(e.data);
    } catch {
      return; // ignore malformed frame
    }
    const env: SpineEvent = { id: e.lastEventId, type, event: parsed };
    // New array ref so useSyncExternalStore detects the change; cap length.
    const next = events.length >= MAX_EVENTS
      ? [...events.slice(events.length - MAX_EVENTS + 1), env]
      : [...events, env];
    events = next;
    emit();
  };

  const connect = () => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") {
      return; // SSR / non-browser — no-op
    }
    es = new EventSource(SSE_URL);
    es.onopen = () => {
      if (!connected) {
        connected = true;
        emit();
      }
    };
    // EventSource auto-reconnects on error using the server's retry hint;
    // we don't close on error (that would defeat auto-reconnect).
    for (const t of ALL_EVENT_TYPES) {
      es.addEventListener(t, handlerFor(t));
    }
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (!es) connect();
      return () => {
        listeners.delete(listener);
        // Keep the connection open even at refcount 0 — the dashboard is a
        // single long-lived page and tearing down/reopening on every mount
        // churn would drop events. The connection lives for the page session.
      };
    },
    getSnapshot() {
      return events;
    },
    getConnected() {
      return connected;
    },
  };
}

// Module-level singleton — one connection for the whole page.
const store = createSpineStore();

/**
 * Subscribe to spine events. Pass `types` to filter; omit for all events.
 * Returns the most recent ≤500 events (oldest → newest).
 */
export function useSSE(types?: readonly DomainEventType[]): SpineEvent[] {
  const all = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    () => EMPTY,
  );
  const key = types ? [...types].join(",") : "";
  return useMemo(() => {
    if (!types || types.length === 0) return all;
    const set = new Set(types);
    return all.filter((e) => set.has(e.type));
  }, [all, key]); // `key` stands in for `types` identity
}

/**
 * Convenience: the most recent event of a single type, fully narrowed, or
 * null if none seen yet. Ideal for "current value" tiles (AnchorPill, etc.).
 */
export function useLatestEvent<T extends DomainEventType>(
  type: T,
): EventOf<T> | null {
  const events = useSSE([type]);
  const last = events.length > 0 ? events[events.length - 1] : null;
  return last ? (last.event as EventOf<T>) : null;
}

/** True once the SSE connection has opened. Drives a "live" indicator. */
export function useSpineConnected(): boolean {
  return useSyncExternalStore(
    store.subscribe,
    store.getConnected,
    () => false,
  );
}
