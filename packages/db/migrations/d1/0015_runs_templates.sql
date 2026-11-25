-- Migration 0015_runs_templates: runs keep the normalized request they were
-- quoted from (a tool page `promptSpec` or a canvas scope) so Activity can show
-- it and `POST /api/runs/:id/retry` can re-quote the failed items; templates
-- gain the fields the Templates page lists and workspace templates ("save
-- selection as template"). Mirrors packages/db/src/d1/schema.ts.

-- `request` JSON: { promptSpec, onlyRefs?, priorAssets?, retryOf? } or { scope, nodeIds?, retryOf? }.
ALTER TABLE quotes ADD COLUMN request TEXT;
ALTER TABLE runs ADD COLUMN request TEXT;
-- The run this one retries (failed/canceled items of it).
ALTER TABLE runs ADD COLUMN retry_of TEXT;
-- Tool of a spec run: quick (image/video), remix, avatar, character; null for canvas runs.
ALTER TABLE runs ADD COLUMN tool TEXT;
-- Character runs: the Character saved from the outputs.
ALTER TABLE runs ADD COLUMN character_id TEXT;

ALTER TABLE templates ADD COLUMN description TEXT;
-- { durationSec, ratio, roles, hasLines, tags[], featured, nodeCount, skill? }
ALTER TABLE templates ADD COLUMN meta TEXT NOT NULL DEFAULT '{}';
ALTER TABLE templates ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE templates ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX templates_ws ON templates (workspace_id, category, uses DESC);
