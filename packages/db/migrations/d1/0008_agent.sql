-- M6 agent: proposal index (proposal id -> thread for apply/discard routes) and per-workspace daily turn counts (D-007 abuse limit).
CREATE TABLE agent_proposals (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, workspace_id TEXT NOT NULL, project_id TEXT, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'proposed', created_at INTEGER NOT NULL);
CREATE INDEX agent_proposals_thread ON agent_proposals (thread_id);
CREATE TABLE agent_usage (workspace_id TEXT NOT NULL, day TEXT NOT NULL, turns INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (workspace_id, day));
ALTER TABLE agent_threads ADD COLUMN created_by TEXT;
CREATE INDEX agent_threads_ws ON agent_threads (workspace_id, updated_at DESC);
