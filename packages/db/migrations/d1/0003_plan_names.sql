-- D-006: plans are Starter, Plus, Pro (was Starter, Pro, Studio).
-- SQLite cannot change a CHECK constraint in place, so the table is rebuilt.
-- Existing rows map pro -> plus and studio -> pro (same perks tier order).
CREATE TABLE subscriptions_new (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), plan TEXT NOT NULL CHECK (plan IN ('starter','plus','pro')), interval TEXT NOT NULL CHECK (interval IN ('month','year')), status TEXT NOT NULL, current_period_end INTEGER NOT NULL, cancel_at_period_end INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
INSERT INTO subscriptions_new (id, workspace_id, plan, interval, status, current_period_end, cancel_at_period_end, updated_at)
  SELECT id, workspace_id, CASE plan WHEN 'pro' THEN 'plus' WHEN 'studio' THEN 'pro' ELSE plan END, interval, status, current_period_end, cancel_at_period_end, updated_at FROM subscriptions;
DROP TABLE subscriptions;
ALTER TABLE subscriptions_new RENAME TO subscriptions;
