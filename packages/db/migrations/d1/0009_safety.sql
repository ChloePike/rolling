-- Migration 0009_safety (D-005 hard limits): safety event log for review, the
-- workspace review flag, content ratings on assets, and the verdict cache.
-- No prompt text beyond a 200-character excerpt and no media copies are stored.
CREATE TABLE safety_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT,
  run_id TEXT,
  job_id TEXT,
  stage TEXT NOT NULL CHECK (stage IN ('pre','post','agent','quote','upload')),
  verdict TEXT NOT NULL CHECK (verdict IN ('allow','block')),
  codes TEXT NOT NULL DEFAULT '[]',
  model TEXT,
  excerpt TEXT,
  hard INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX safety_events_ws ON safety_events (workspace_id, hard, created_at DESC);
CREATE INDEX safety_events_time ON safety_events (created_at DESC);

-- Set after FLAG_THRESHOLD hard-limit blocks in 24 h: mature runs are refused until cleared by review.
ALTER TABLE workspaces ADD COLUMN safety_flag INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workspaces ADD COLUMN safety_flagged_at INTEGER;

-- Content rating of every output and upload (D-005 visibility uses it, not the run's mature flag).
ALTER TABLE assets ADD COLUMN rating TEXT CHECK (rating IS NULL OR rating IN ('safe','suggestive','explicit'));
ALTER TABLE assets ADD COLUMN rating_confidence REAL;
ALTER TABLE assets ADD COLUMN rating_model TEXT;

-- Classifier assessments by content hash (prompt version included in the key).
CREATE TABLE safety_cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX safety_cache_expiry ON safety_cache (expires_at);
