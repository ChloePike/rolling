-- D-012 agent allowance: per-turn cost history (mirror of the CreditAccount agent ledger). Replaces the daily turn counts of 0008.
DROP TABLE IF EXISTS agent_usage;
CREATE TABLE agent_usage (turn_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, user_id TEXT, thread_id TEXT, llm TEXT NOT NULL, period_start INTEGER NOT NULL, cost_usd REAL NOT NULL DEFAULT 0, overrun_usd REAL NOT NULL DEFAULT 0, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'settled', created_at INTEGER NOT NULL);
CREATE INDEX agent_usage_ws ON agent_usage (workspace_id, period_start);
CREATE INDEX agent_usage_ws_llm ON agent_usage (workspace_id, llm, created_at DESC);
