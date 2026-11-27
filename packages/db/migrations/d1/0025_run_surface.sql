-- Migration 0025_run_surface: runs record where they were started, so Activity can tell a
-- Home prompt-box run from a Quick Create one (docs/ux-audit.md #28). Mirrors
-- packages/db/src/d1/schema.ts. Values: home, quick, remix, avatar, character, canvas, agent.
-- Older rows stay NULL; the API guesses from `tool` and `source` (apps/api/src/runs/surface.ts).
ALTER TABLE runs ADD COLUMN surface TEXT;
