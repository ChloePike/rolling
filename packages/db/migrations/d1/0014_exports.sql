-- Migration 0014_exports: MP4 exports of a project's timeline (ExportWorkflow + FfmpegRenderer).
-- Mirrors packages/db/src/d1/schema.ts. Exports are free of credits for now (docs/api.md → Editor).
CREATE TABLE exports (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  canvas_id TEXT NOT NULL,
  preset TEXT NOT NULL CHECK (preset IN ('mp4_1080p','mp4_720p')),
  range_start REAL,
  range_end REAL,
  timeline_revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','done','failed')),
  progress REAL NOT NULL DEFAULT 0,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  duration REAL NOT NULL,
  asset_id TEXT,
  r2_key TEXT,
  size INTEGER,
  error_code TEXT,
  error_message TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX exports_project ON exports (project_id, created_at DESC);
