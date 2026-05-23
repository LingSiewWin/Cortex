-- Cortex SQLite mirror schema
--
-- This file is the source of truth for the bun:sqlite event mirror.
-- Loaded by src/mirror/db.ts on daemon start. Idempotent: safe to re-run.
--
-- ERC-5169 scriptURI commitment: the running daemon + this schema + the public
-- Arkiv event stream is sufficient to reconstruct full Cortex state without
-- trusting the Cortex backend.

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
-- WAL allows N readers but only ONE writer at a time. With three concurrent
-- hydrate workers + the main poll loop + dashboard's read connections, write
-- contention is inevitable. Default busy_timeout is 0 = fail immediately.
-- 5000ms means SQLite will retry a locked write for up to 5 seconds before
-- giving up, which absorbs all of our normal contention windows.
-- See docs/MIRROR.md §1 for the full investigation.
PRAGMA busy_timeout = 5000;

-- Latest known state per entity. Updated on every create/update/extend/transfer event,
-- soft-deleted on delete/expire. Always represents our best-known current truth.
CREATE TABLE IF NOT EXISTS entities (
  entity_key            TEXT PRIMARY KEY,           -- 0x… 32-byte hex
  owner                 TEXT NOT NULL,              -- 0x… current owner (mutable)
  creator               TEXT,                       -- 0x… set on first getEntity hydration (immutable)
  content_type          TEXT,
  payload               BLOB,                       -- raw bytes (encrypted at app layer if Privacy theme)
  attributes_json       TEXT,                       -- JSON.stringify(Attribute[])
  expires_at_block      INTEGER NOT NULL,           -- last-known expirationBlock from events
  created_at_block      INTEGER,
  last_modified_at_block INTEGER,
  state                 TEXT NOT NULL DEFAULT 'live', -- 'live' | 'deleted' | 'expired'
  first_seen_block      INTEGER NOT NULL,           -- block at which mirror first saw this entity
  last_event_block      INTEGER NOT NULL,
  last_event_type       TEXT NOT NULL,              -- 'created' | 'updated' | 'extended' | 'deleted' | 'expired' | 'owner_changed'
  hydrated_at_ms        INTEGER,                    -- local ms timestamp of last successful getEntity fetch
  -- Phase 12 — Merkleized Memory. keccak256(payload), hex-encoded.
  -- NULL for: entities the daemon saw the event for but couldn't hydrate.
  -- Set lazily on first successful hydration. Backfill migration in db.ts
  -- populates this for any existing row that has payload but missing hash.
  payload_hash          TEXT
);

CREATE INDEX IF NOT EXISTS idx_entities_state    ON entities(state);
CREATE INDEX IF NOT EXISTS idx_entities_owner    ON entities(owner);
CREATE INDEX IF NOT EXISTS idx_entities_creator  ON entities(creator);
CREATE INDEX IF NOT EXISTS idx_entities_expires  ON entities(expires_at_block);

-- Append-only event log. Never updated, never deleted. The source of truth for
-- replay-based reconstruction: drop the `entities` table and rebuild it by
-- replaying events in (block_number, log_index) order.
CREATE TABLE IF NOT EXISTS events (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  block_number          INTEGER NOT NULL,
  tx_hash               TEXT,
  log_index             INTEGER,                    -- order within block, for replay determinism
  event_type            TEXT NOT NULL,              -- 'created' | 'updated' | 'extended' | 'deleted' | 'expired' | 'owner_changed'
  entity_key            TEXT NOT NULL,
  owner                 TEXT,
  old_owner             TEXT,                       -- for owner_changed
  new_owner             TEXT,                       -- for owner_changed
  old_expiration_block  INTEGER,                    -- for updated, extended
  new_expiration_block  INTEGER,                    -- for created, updated, extended
  cost                  TEXT,                       -- bigint serialised as decimal string
  observed_at_ms        INTEGER NOT NULL            -- mirror's local clock when event was processed
);

CREATE INDEX IF NOT EXISTS idx_events_entity_key   ON events(entity_key);
CREATE INDEX IF NOT EXISTS idx_events_block_number ON events(block_number);
CREATE INDEX IF NOT EXISTS idx_events_type         ON events(event_type);

-- Mirror daemon state — resume cursor, project filter membership cache.
CREATE TABLE IF NOT EXISTS daemon_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Known-Cortex-entity cache: avoids re-hydrating cross-project entities on every event.
-- Membership semantics:
--   in_project = 1  → confirmed has PROJECT_ATTRIBUTE
--   in_project = 0  → confirmed does NOT have PROJECT_ATTRIBUTE
-- Absent entry = not yet checked.
CREATE TABLE IF NOT EXISTS entity_membership (
  entity_key TEXT PRIMARY KEY,
  in_project INTEGER NOT NULL CHECK (in_project IN (0, 1)),
  checked_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_membership_in_project ON entity_membership(in_project);

-- Citation counters for the Darwinian engine. Each act() call increments
-- `count` for every memory it cites and records `last_session_id`. Crossing
-- REINFORCEMENT.promoteToEpisodic / .promoteToSemantic triggers tier promotion
-- (ownership transfer + LLM distillation respectively).
--
-- `distinct_sessions` is the count of unique session ids that have cited this
-- memory. It's tracked separately so the semantic threshold (>= 3 distinct
-- sessions) doesn't get gamed by a single long-running session.
CREATE TABLE IF NOT EXISTS citation_counts (
  entity_key        TEXT PRIMARY KEY,
  count             INTEGER NOT NULL DEFAULT 0,
  distinct_sessions INTEGER NOT NULL DEFAULT 0,
  last_session_id   TEXT,
  last_cited_ms     INTEGER NOT NULL,
  entity_type       TEXT,           -- 'observation' | 'episode' | 'rule'
  promoted_to       TEXT,           -- NULL | 'episode' | 'rule'
  -- SEDM-fusion utility weight (docs/research/2026-05-23-sedm-fusion-design.md).
  -- `weight` = evolved per-memory utility, drives recall ranking + lease scaling.
  -- `audit_s` / `audit_epoch` reserved for Phase B (verifiable on-chain audit).
  weight            REAL NOT NULL DEFAULT 1.0,
  last_weight_ms    INTEGER,
  audit_s           REAL,
  audit_epoch       INTEGER
);

CREATE INDEX IF NOT EXISTS idx_citation_counts_count    ON citation_counts(count);
CREATE INDEX IF NOT EXISTS idx_citation_counts_promoted ON citation_counts(promoted_to);

-- Session-id -> entity-key witness table. Lets us compute distinct_sessions
-- without scanning the events log. Insert-or-ignore on every citation; the
-- presence of the (session_id, entity_key) pair tells us not to bump
-- distinct_sessions a second time.
CREATE TABLE IF NOT EXISTS citation_sessions (
  session_id TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  first_cited_ms INTEGER NOT NULL,
  PRIMARY KEY (session_id, entity_key)
);

CREATE INDEX IF NOT EXISTS idx_citation_sessions_entity ON citation_sessions(entity_key);

-- ===========================================================================
-- Phase 12 — Merkleized Memory state roots
--
-- Every time we anchor the MMR's current root to Arkiv (Phase 13), one row
-- gets inserted here. The leaf_count + trigger_reason explain WHY the root
-- moved (manual force / agent decision / periodic / etc.). anchored_tx_hash
-- starts NULL and is filled when the Arkiv tx confirms.
--
-- The MMR itself is rebuilt from `entities.payload_hash` on daemon boot —
-- we don't persist intermediate tree nodes. Trade-off: O(N) cold start vs
-- zero schema churn when the tree algorithm changes.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS state_roots (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  root_hex          TEXT NOT NULL UNIQUE,         -- 0x… 32-byte hex
  leaf_count        INTEGER NOT NULL,             -- MMR size at time of commit
  computed_at_ms    INTEGER NOT NULL,             -- mirror's local clock
  trigger_reason    TEXT NOT NULL DEFAULT 'manual', -- 'manual' | 'act' | 'periodic' | 'boot'
  -- Anchor metadata — NULL until Phase 13 actually broadcasts to Arkiv.
  anchored_tx_hash  TEXT,
  anchored_at_block INTEGER,
  anchored_at_ms    INTEGER,
  anchored_entity_key TEXT                        -- the Arkiv entity key carrying this root
);

CREATE INDEX IF NOT EXISTS idx_state_roots_leaf_count ON state_roots(leaf_count);
CREATE INDEX IF NOT EXISTS idx_state_roots_anchored ON state_roots(anchored_at_block);

-- Synaptic Market — persisted per-listing decryption keys.
--
-- Each listing is encrypted with a fresh AES-256-GCM key in src/market/publish.ts.
-- The seller's relayer must release that key in response to a Grant event. v1
-- previously held the map in memory, so a process restart left already-paid
-- buyers without fulfilment. We now seal each key under the user-derived
-- payload key (lib/crypto.ts derivePayloadKey) and persist the ciphertext +
-- nonce here, so the daemon can hydrate the map on boot.
CREATE TABLE IF NOT EXISTS listing_keys (
  entity_key            TEXT PRIMARY KEY,         -- the listing's Arkiv entity key
  decryption_key_sealed BLOB NOT NULL,            -- AES-wrapped under user-derived key
  nonce                 BLOB NOT NULL,            -- AES-GCM nonce used to seal
  created_at_ms         INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- Agent Allowances (Phase 11)
-- ---------------------------------------------------------------------------
-- A master (human or another agent) signs a `SessionAuthorizationV2` granting
-- an ephemeral session key a GLM budget + write count cap + refill threshold
-- + projected daily-cost. The relayer tracks cumulative spend per session
-- here. When spend nears threshold the dashboard alerts to refill; when spend
-- hits cap the relayer refuses further writes until the master re-signs.
--
-- State machine: active → exhausted (cap hit) → expired (validBefore passed).
-- `state` is the persisted hint; the read helpers in db.ts compute the
-- effective state lazily from spent_wei / write_count / valid_before so the
-- column never disagrees with the truth.
CREATE TABLE IF NOT EXISTS agent_allowances (
  session_key                TEXT PRIMARY KEY,        -- the agent's ephemeral EOA
  master                     TEXT NOT NULL,           -- the user/master EOA
  scope                      TEXT NOT NULL,
  entity_namespace           TEXT NOT NULL,
  max_writes                 INTEGER NOT NULL,
  max_gas_wei                TEXT NOT NULL,           -- bigint decimal string
  refill_threshold_wei       TEXT NOT NULL,
  estimated_daily_cost_wei   TEXT NOT NULL,
  spent_wei                  TEXT NOT NULL DEFAULT '0',
  write_count                INTEGER NOT NULL DEFAULT 0,
  valid_after                INTEGER NOT NULL,
  valid_before               INTEGER NOT NULL,
  nonce                      TEXT NOT NULL,
  state                      TEXT NOT NULL DEFAULT 'active', -- active|exhausted|expired|paused
  created_at_ms              INTEGER NOT NULL,
  last_spend_at_ms           INTEGER,
  refilled_from              TEXT                     -- prev session_key when this is a refill
);

CREATE INDEX IF NOT EXISTS idx_allowances_master ON agent_allowances(master);
CREATE INDEX IF NOT EXISTS idx_allowances_state ON agent_allowances(state);

-- Append-only spend log per allowance. One row per relayer write that was
-- charged against an allowance. The "Last 12 spends" sparkline on the
-- dashboard reads this table newest-first.
CREATE TABLE IF NOT EXISTS allowance_spends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_key   TEXT NOT NULL,
  tx_hash       TEXT,
  gas_wei       TEXT NOT NULL,                       -- bigint decimal string
  write_count_delta INTEGER NOT NULL DEFAULT 1,
  at_ms         INTEGER NOT NULL,
  FOREIGN KEY (session_key) REFERENCES agent_allowances(session_key)
);

CREATE INDEX IF NOT EXISTS idx_spends_session ON allowance_spends(session_key);
CREATE INDEX IF NOT EXISTS idx_spends_at_ms ON allowance_spends(at_ms);
