-- Migration 0032_review (D-024, result review: a cheap vision model reviews each generation output).
-- 1. user_prefs.review_results: Settings → Preferences → Review results (on).
-- 2. jobs.review: the verdict (scores per dimension, issues, fix, best take, action); review_cost_usd: its gateway
--    cost, covered from the margin (never held or charged).
-- 3. review_retries: Auto mode's automatic retries with a review fix, at most one per node per budget key (the agent
--    turn, else the run); `credits` count against the turn's budget; `prev_params` restores the node when the
--    original version stays current.
ALTER TABLE user_prefs ADD COLUMN review_results INTEGER NOT NULL DEFAULT 1;
ALTER TABLE jobs ADD COLUMN review TEXT;
ALTER TABLE jobs ADD COLUMN review_cost_usd REAL;
CREATE TABLE review_retries (
  budget_key TEXT NOT NULL,
  node_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  retry_run_id TEXT,
  credits INTEGER NOT NULL,
  prev_params TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (budget_key, node_id)
);
