-- AgentSession Durable Object (SQLite). One instance per agent thread.
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);            -- workspace_id, project_id, surface, skill, summary
CREATE TABLE messages (id TEXT PRIMARY KEY, role TEXT NOT NULL, content TEXT NOT NULL, tokens_in INTEGER, tokens_out INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE proposals (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('plan','graphPatch','timelinePatch','fields')), base_revision INTEGER, body TEXT NOT NULL, estimate INTEGER, status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','applied','discarded','stale')), decided_at INTEGER);
-- v2
ALTER TABLE messages ADD COLUMN proposal_id TEXT;
ALTER TABLE messages ADD COLUMN turn_id TEXT;
ALTER TABLE proposals ADD COLUMN created_at INTEGER;
ALTER TABLE proposals ADD COLUMN stale_reason TEXT;
CREATE INDEX messages_created ON messages (created_at);
-- v3 (D-021): Auto mode changes (undoable one by one), runs and per-turn budgets
CREATE TABLE auto_changes (id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, proposal_id TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL, project_id TEXT, revision INTEGER NOT NULL, ops INTEGER NOT NULL, node_ids TEXT NOT NULL, undo TEXT, status TEXT NOT NULL DEFAULT 'applied', created_at INTEGER NOT NULL);
CREATE INDEX auto_changes_turn ON auto_changes (turn_id);
CREATE TABLE auto_runs (id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, node_ids TEXT NOT NULL, credits INTEGER NOT NULL, status TEXT NOT NULL, run_id TEXT, code TEXT, created_at INTEGER NOT NULL);
CREATE INDEX auto_runs_turn ON auto_runs (turn_id);
CREATE TABLE auto_turns (turn_id TEXT PRIMARY KEY, budget INTEGER NOT NULL, spent INTEGER NOT NULL, created_at INTEGER NOT NULL);
