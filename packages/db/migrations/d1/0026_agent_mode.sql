-- Migration 0026_agent_mode (D-021): the agent mode a new project (and Home) starts in, and
-- Auto mode's per-turn budget. Mirrors packages/db/src/d1/schema.ts.
-- agent_mode: read | edit | auto (default edit, the previous behaviour).
-- auto_budget: credits per turn; NULL follows confirm_threshold.
ALTER TABLE user_prefs ADD COLUMN agent_mode TEXT NOT NULL DEFAULT 'edit';
ALTER TABLE user_prefs ADD COLUMN auto_budget INTEGER;
