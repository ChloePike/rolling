-- Migration 0018_privacy: durable account deletion (background job over Durable Objects),
-- self-serve data export, and indexes for the retention purge and pseudonymisation.
-- Mirrors packages/db/src/d1/schema.ts. Retention periods: packages/core/src/privacy.ts.

-- One row per deleted account. `user_id` holds the raw id only while the job runs; it is
-- replaced by the tombstone when the job finishes.
CREATE TABLE account_deletions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  tombstone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  done_at INTEGER
);
CREATE INDEX account_deletions_pending ON account_deletions (status, updated_at);

-- Work items of a deletion job: Durable Objects to wipe or pseudonymise.
CREATE TABLE account_deletion_items (
  deletion_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('project_room','project_pseudonymize','agent_session','credit_account','user_hub')),
  ref TEXT NOT NULL,
  done_at INTEGER,
  PRIMARY KEY (deletion_id, kind, ref)
);
CREATE INDEX account_deletion_items_pending ON account_deletion_items (deletion_id, done_at);

-- Settings → Account → Export my data (DataExportWorkflow).
CREATE TABLE data_exports (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','expired')),
  r2_key TEXT,
  size INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  expires_at INTEGER
);
CREATE INDEX data_exports_user ON data_exports (user_id, created_at DESC);

-- Retention purge and pseudonymisation lookups.
CREATE INDEX agent_usage_time ON agent_usage (created_at);
CREATE INDEX agent_usage_user ON agent_usage (user_id);
CREATE INDEX safety_events_user ON safety_events (user_id);
CREATE INDEX ledger_lines_user ON ledger_lines (user_id);
