-- Migration 0024_prompt_expand (D-020, "Enhance prompt": Hyperouter prompt expansion).
-- 1. user_prefs.enhance_prompt: the default of the per-run toggle (on).
-- 2. jobs.expanded_prompt: the prompt that rendered when the gateway expanded it (shown as "Enhanced prompt").
-- 3. gateway_features: per-environment state of gateway features the account may not have yet. A `403
--    feature_not_enabled` stores `prompt_expand` as off; the model sync clears it after a day so a run tries again.
ALTER TABLE user_prefs ADD COLUMN enhance_prompt INTEGER NOT NULL DEFAULT 1;
ALTER TABLE jobs ADD COLUMN expanded_prompt TEXT;
CREATE TABLE gateway_features (
  feature TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL,
  reason TEXT,
  checked_at INTEGER NOT NULL
);
