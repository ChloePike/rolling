-- AgentSession Durable Object (SQLite). One instance per agent thread.
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);            -- workspace_id, project_id, surface, skill, summary
CREATE TABLE messages (id TEXT PRIMARY KEY, role TEXT NOT NULL, content TEXT NOT NULL, tokens_in INTEGER, tokens_out INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE proposals (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('plan','graphPatch','timelinePatch','fields')), base_revision INTEGER, body TEXT NOT NULL, estimate INTEGER, status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','applied','discarded','stale')), decided_at INTEGER);
