-- Migration 0006_projects_assets (M3): upload state and D-005 flag on assets,
-- share link ownership, character authorship. Mirrors packages/db/src/d1/schema.ts.

-- Upload lifecycle: uploading (multipart open) -> processing (queued for media.process) -> ready | failed.
ALTER TABLE assets ADD COLUMN status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('uploading','processing','ready','failed'));
-- D-005: mature outputs are never signed for users who may not see them and never shown on public surfaces.
ALTER TABLE assets ADD COLUMN mature INTEGER NOT NULL DEFAULT 0;
ALTER TABLE assets ADD COLUMN size INTEGER;
ALTER TABLE assets ADD COLUMN content_type TEXT;
CREATE INDEX assets_source ON assets (source, kind, created_at DESC);
CREATE INDEX assets_project ON assets (project_id);

ALTER TABLE share_links ADD COLUMN workspace_id TEXT;
ALTER TABLE share_links ADD COLUMN created_by TEXT;
ALTER TABLE share_links ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX share_links_project ON share_links (project_id);

ALTER TABLE characters ADD COLUMN created_by TEXT;
CREATE INDEX characters_ws ON characters (workspace_id, created_at DESC);
CREATE INDEX voices_ws ON voices (workspace_id);
