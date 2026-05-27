# Cortex Mirror — Operational Notes

> Field notes from running the Cortex SQLite mirror against Braga, captured 2026-05-21 after hitting `SQLITE_BUSY` and `NoEntityFoundError` floods during backfill + live polling. Both have known root causes and clean mitigations; both are documented here so we don't relitigate them.

This file is **load-bearing** for anyone debugging the mirror. If you hit a new failure mode, add it here.

---

## §1 — `SQLITE_BUSY: database is locked`

### Symptom

```
[mirror] hydrate failed for 0x7248…: SQLiteError: database is locked
  errno: 5,
  code: "SQLITE_BUSY"
  at setMembership (src/mirror/db.ts:131:5)
```

Pops in both `bun run mirror` and `bun run backfill`. Reproducibility is non-deterministic — depends on timing.

### Root cause

SQLite in WAL mode allows:

- **N concurrent readers** (great)
- **Exactly one writer at a time** (the constraint)

Cortex has **multiple writers** at any given moment:

| Writer | Frequency |
|---|---|
| Mirror daemon main loop — inserts to `events`, updates `daemon_state` cursor | Per Arkiv event observed (every ~2s) |
| 3 hydrate workers — write to `entity_membership`, `entities` | Up to 3 parallel `setMembership` / entity upserts |
| Dashboard server — initMirrorDb runs `db.exec(ddl)` which briefly holds a write lock | Per cold start |
| Backfill (if running concurrently) — same writers as the daemon, fired in tight loop | Continuous during backfill |

The default `busy_timeout` is **0 milliseconds** — meaning any write that hits a locked database fails *instantly* with `SQLITE_BUSY`. This is hostile for concurrent applications and is widely considered a SQLite footgun ([the docs themselves recommend setting it](https://www.sqlite.org/c3ref/busy_timeout.html)).

### The fix

Set `PRAGMA busy_timeout = 5000` on every connection. SQLite will then retry locked writes for up to 5 seconds before giving up.

We set this in **two places** for belt-and-braces:

1. **`src/mirror/schema.sql`** — top of file, runs once on schema apply
2. **`src/mirror/db.ts initMirrorDb()`** — explicit per-connection `db.exec("PRAGMA busy_timeout = 5000;")` *before* the schema DDL

Per-connection is the critical one — `busy_timeout` is connection-scoped, so each process that opens the mirror file (daemon, backfill, dashboard server) must set its own. The schema-file copy exists for documentation and as a safety net.

### Why not "serialize all writes through one queue"?

Considered and rejected for v1:

- Would require wrapping every `db.prepare().run()` in a global mutex/queue
- SQLite + `busy_timeout` already gives this for free at the storage layer
- The cost we trade: under heavy contention some writes wait up to 5s. Acceptable for a hackathon-scale mirror. Reconsider in v2 when contention grows.

### What if 5s isn't enough?

You'll see the error again, with the same stack trace. Diagnosis:

```bash
# Find which process is holding the writer lock
lsof cortex-mirror.sqlite
fuser cortex-mirror.sqlite
```

Common culprits:
- Stale daemon from a previous shell session
- Dashboard server still running in background (`lsof -i :3000`)
- `bun --hot` HMR holding the connection across reloads

Bump `busy_timeout` to 30000 only if you've confirmed contention is legitimate and not a runaway process.

---

## §2 — `NoEntityFoundError: No entity found`

### Symptom

```
[mirror] hydrate failed for 0x346da17b…: NoEntityFoundError: No entity found
  at getEntity (node_modules/@arkiv-network/sdk/src/actions/public/getEntity.ts:46:11)
  at async hydrateEntity (src/mirror/daemon.ts:418:39)
```

Floods of these during `bun run backfill`. Each one corresponds to an entity whose `Created` event we observed in the historical event log, but whose current state Arkiv reports as missing.

### Root cause — this is Arkiv working as designed

Cortex's working-tier memories ship with a **1-hour expiration** (`REINFORCEMENT.initialWorkingSeconds`). The backfill script scans the last **5000 blocks** by default (configurable via `BACKFILL_BLOCKS`). At Braga's 2-second block time:

```
5000 blocks × 2 s/block = 10,000 seconds ≈ 2.78 hours
```

That window is **wider than the working-tier lifespan**. So when backfill replays a `Created` event from ~2.5 hours ago and our daemon tries to call `getEntity(key)` to fetch attributes + payload, Arkiv correctly reports: *"that entity expired ~90 minutes ago and was swept by the L1Block system depositor."* There is no current state to fetch.

This is the **Darwinian engine working correctly viewed from the wrong angle**. The chain forgot the memory because nothing cited it. The event log remembers the create; the state does not.

### Why we can't "just query historically"

Per [`docs/Arkiv.md` §1.6 (the canary finding)](./Arkiv.md), Braga's `validAtBlock` parameter is **silently ignored** by the server. So we can't ask "give me this entity's state as it existed at the block it was created." The SDK supports the API; the server doesn't implement it. Our `tests/canary-atblock.test.ts` test deliberately asserts this broken behavior — if it ever starts passing, we have a much richer recovery path.

### The fix

Catch `NoEntityFoundError` specifically in `hydrateEntity`:

```ts
// src/mirror/daemon.ts hydrateEntity
} catch (err) {
  const errName = (err as { name?: string })?.name;
  if (errName === "NoEntityFoundError") {
    // Mark membership=false so we don't try again, log at info level
    try { setMembership(db, entityKey, false); } catch {/* contention OK */}
    log(`[mirror] entity ${entityKey.slice(0,10)}… already evicted on Arkiv`);
    return;
  }
  // Anything else IS a real failure
  console.error(`[mirror] hydrate failed for ${entityKey}:`, err);
}
```

We match by `err.name` rather than `instanceof NoEntityFoundError` to avoid importing internals — `errors.ts` IS re-exported from `@arkiv-network/sdk` (verified in source), but the name check is bundle-stable across SDK versions.

### Consequence — backfill is intentionally lossy

This is **a feature, not a bug** when framed correctly:

- Backfill ingests **events** (which Arkiv's chain retains permanently) into our SQLite event log
- Backfill ingests **state** (which Arkiv evicts on expiry) only for entities that are *still alive*
- The replay path in `src/mirror/replay.ts` reconstructs whatever it can from the event log alone

The pitch deck framing: *"Cortex's mirror tracks every event for sovereignty, but only hydrates entities Arkiv still has. The chain forgets useless memories so we don't have to store them ourselves."*

---

## §3 — Process model: mirror + backfill + dashboard

Three processes can legitimately access the mirror file simultaneously:

| Process | Lock pattern | Notes |
|---|---|---|
| `bun run dashboard` (Bun.serve) | Mostly reads. Brief write lock on init for schema DDL. | Open the file lazily on first `/api/*` request. |
| `bun run mirror` | Continuous writer (every event = 1+ writes). Plus 3 hydrate-worker writes. | The hot path. |
| `bun run backfill` | Burst writer. Adds N entries to events table + N membership writes in tight succession. | Run **before** the daemon on first boot, or alongside on subsequent runs. |

### Safe sequences

**Cold start (no mirror file yet):**
```bash
bun run backfill        # creates the SQLite file, ingests historical window
bun run mirror &        # tails new events
bun run dashboard       # reads only
```

**Warm restart (mirror file exists):**
```bash
bun run dashboard       # already running is fine
bun run mirror          # resumes from daemon_state cursor
```

**Reset (start fresh):**
```bash
# Stop all processes first
rm cortex-mirror.sqlite*  # wal + shm files included (per .gitignore pattern)
bun run backfill
bun run mirror &
```

### What you DON'T want

- Two `bun run mirror` instances against the same file — they will both write the resume cursor and overlap event ingestion. Idempotent on the events table (UNIQUE constraint via id auto-increment + block+log_index is safe), but expect noisy duplicate-key warnings.
- Running `bun run backfill` repeatedly against an already-backfilled window — does no harm (idempotent ON CONFLICT logic), but wastes RPC quota.

---

## §4 — Diagnostics

### "Is the daemon actually doing anything?"

The daemon prints a heartbeat every 30 seconds:

```
[mirror] heartbeat @ 60s — last block 673783, 149 events seen, hydrate q=0 active=0
```

- `last block` should advance every poll cycle (Braga is 2s, daemon polls every 2s)
- `events seen` is cumulative across the process lifetime
- `hydrate q` is the pending queue depth; `active` is concurrent workers (max 3)

If `last block` is stuck for >2 minutes, the daemon is wedged. Check stderr for RPC errors.

### "Why does `/api/memories` show 0 entities even though I created some?"

Three orthogonal causes:

1. Daemon hasn't observed your create yet → check `events seen` count
2. Daemon observed but hasn't finished hydrating → check `hydrate q`
3. Hydration succeeded but the entity isn't tagged with `PROJECT_ATTRIBUTE` → check `membership` table:

```bash
sqlite3 cortex-mirror.sqlite "SELECT * FROM entity_membership WHERE entity_key = '0xYOURKEY';"
```

If `in_project = 0`, the daemon confirmed it's NOT a Cortex entity. If the row is missing, hydration hasn't completed (or failed silently).

### "How many evictions has the chain done for us?"

```bash
sqlite3 cortex-mirror.sqlite "SELECT COUNT(*) FROM events WHERE event_type = 'expired';"
```

This is the headline "free GC" number we surface on the dashboard `/api/decay` endpoint.

---

## §5 — Known limitations + v2 roadmap

| Limitation | v2 fix |
|---|---|
| `busy_timeout = 5000` may not absorb pathological contention | Move to a serialized-writer queue with channel-based throttling |
| Backfill is lossy for entities that expired before observation | When `validAtBlock` is fixed upstream, replay from events table with proper historical reads |
| Hydrate workers share the daemon's DB connection — write contention is high | Open a pooled write connection per worker (bun:sqlite supports this via second Database instance) |
| Dashboard's `initMirrorDb` runs schema DDL on every cold start | Move to a one-shot migrator script invoked from `bun run setup` |
| No WAL checkpoint scheduling — WAL file can grow unbounded under heavy load | Add `PRAGMA wal_autocheckpoint = 1000` + periodic `PRAGMA wal_checkpoint(TRUNCATE)` |

---

## References

- SQLite WAL mode: <https://www.sqlite.org/wal.html>
- SQLite `busy_timeout`: <https://www.sqlite.org/c3ref/busy_timeout.html>
- bun:sqlite docs: <https://bun.sh/docs/api/sqlite>
- Arkiv `NoEntityFoundError` source: `node_modules/@arkiv-network/sdk/src/errors.ts:22`
- Arkiv eviction semantics: [`docs/Arkiv.md` §1.5 and §1.6](./Arkiv.md)
- The deliberately-failing canary: `tests/canary-atblock.test.ts`
