-- D1 (SQLite). Times are integer epoch ms. JSON columns are TEXT holding JSON.
-- Better Auth creates user, session, account, verification tables via its migration.

CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('personal','team')), stripe_customer_id TEXT UNIQUE, created_at INTEGER NOT NULL);
CREATE TABLE workspace_members (workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, user_id TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')), monthly_credit_limit INTEGER, PRIMARY KEY (workspace_id, user_id));
CREATE TABLE user_prefs (user_id TEXT PRIMARY KEY, language TEXT NOT NULL DEFAULT 'en', currency TEXT NOT NULL DEFAULT 'USD', creation_mode TEXT NOT NULL DEFAULT 'simple', default_ratio TEXT NOT NULL DEFAULT '9:16', default_model TEXT NOT NULL DEFAULT 'auto', confirm_threshold INTEGER NOT NULL DEFAULT 20, notifications TEXT NOT NULL DEFAULT '{"done":true,"low":true,"renewal":true,"product":false}', handle TEXT UNIQUE, bio TEXT);
CREATE TABLE subscriptions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), plan TEXT NOT NULL CHECK (plan IN ('starter','pro','studio')), interval TEXT NOT NULL CHECK (interval IN ('month','year')), status TEXT NOT NULL, current_period_end INTEGER NOT NULL, cancel_at_period_end INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
CREATE TABLE stripe_events (id TEXT PRIMARY KEY, type TEXT NOT NULL, processed_at INTEGER NOT NULL);

CREATE TABLE projects (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), title TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'canvas', thumb_key TEXT, node_count INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX projects_ws ON projects (workspace_id, updated_at DESC);

CREATE TABLE quotes (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT, items TEXT NOT NULL, total INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE runs (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT, quote_id TEXT NOT NULL, scope TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','partial','failed','canceled')), created_by TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE jobs (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), project_id TEXT, node_id TEXT, title TEXT, provider TEXT NOT NULL, model TEXT NOT NULL, params_summary TEXT, external_id TEXT, workflow_id TEXT, status TEXT NOT NULL CHECK (status IN ('queued','submitted','running','succeeded','failed','canceled','unknown')), progress REAL, cost_quote INTEGER NOT NULL, cost_actual INTEGER, refunded INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT NOT NULL UNIQUE, error_code TEXT, created_at INTEGER NOT NULL, finished_at INTEGER);
CREATE INDEX jobs_activity ON jobs (run_id); CREATE INDEX jobs_ext ON jobs (provider, external_id);

CREATE TABLE ledger_lines (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, user_id TEXT, kind TEXT NOT NULL, bucket TEXT NOT NULL, amount INTEGER NOT NULL, run_id TEXT, job_id TEXT, stripe_ref TEXT, created_at INTEGER NOT NULL); -- mirror of CreditAccount
CREATE INDEX ledger_ws ON ledger_lines (workspace_id, created_at DESC);

CREATE TABLE assets (id TEXT PRIMARY KEY, workspace_id TEXT, kind TEXT NOT NULL CHECK (kind IN ('image','video','audio','text')), source TEXT NOT NULL CHECK (source IN ('mine','team','builtin','public','generated')), name TEXT NOT NULL, r2_key TEXT NOT NULL, meta TEXT NOT NULL DEFAULT '{}', license TEXT, project_id TEXT, created_by TEXT, created_at INTEGER NOT NULL);
CREATE INDEX assets_ws ON assets (workspace_id, kind, created_at DESC);
CREATE TABLE public_items (id TEXT PRIMARY KEY, category TEXT NOT NULL, sub TEXT, title TEXT NOT NULL, prompt_en TEXT, prompt_zh TEXT, angles TEXT, asset_id TEXT NOT NULL, license TEXT NOT NULL CHECK (license IN ('cc0','mit','rights-reserved')), source TEXT NOT NULL);
CREATE VIRTUAL TABLE asset_search USING fts5(id UNINDEXED, name, tags);  -- powers the @ picker and library search

CREATE TABLE characters (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL, meta TEXT, cover_asset_id TEXT, versions TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL);
CREATE TABLE voices (id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT NOT NULL, language TEXT, kind TEXT NOT NULL CHECK (kind IN ('builtin','cloned')), status TEXT NOT NULL, provider_ref TEXT, sample_asset_id TEXT);
CREATE TABLE templates (id TEXT PRIMARY KEY, workspace_id TEXT, title TEXT NOT NULL, category TEXT, graph TEXT NOT NULL, slots TEXT NOT NULL, preview_asset_id TEXT, uses INTEGER NOT NULL DEFAULT 0);
CREATE TABLE share_links (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, snapshot_key TEXT NOT NULL, allow_download INTEGER NOT NULL DEFAULT 0, revoked_at INTEGER);
CREATE TABLE agent_threads (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT, surface TEXT NOT NULL, skill TEXT, title TEXT, updated_at INTEGER NOT NULL);
