-- Migration 0031_post_production (D-033 .. D-037): social export presets and options
-- (batch, preview), post-production jobs (auto captions, resize), timeline placements of
-- runs (extend clip, lip-sync) and the workspace brand kit.
-- Mirrors packages/db/src/d1/schema.ts.

-- exports: the preset list grows (SQLite cannot alter a CHECK: rebuild), plus options and batch.
CREATE TABLE exports_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  canvas_id TEXT NOT NULL,
  preset TEXT NOT NULL CHECK (preset IN ('mp4_1080p','mp4_720p','vertical_9x16','square_1x1','landscape_16x9')),
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
  finished_at INTEGER,
  options TEXT NOT NULL DEFAULT '{}',
  batch_id TEXT,
  preview INTEGER NOT NULL DEFAULT 0
);
INSERT INTO exports_new (id, workspace_id, project_id, canvas_id, preset, range_start, range_end, timeline_revision, status, progress, width, height, duration, asset_id, r2_key, size, error_code, error_message, created_by, created_at, finished_at)
  SELECT id, workspace_id, project_id, canvas_id, preset, range_start, range_end, timeline_revision, status, progress, width, height, duration, asset_id, r2_key, size, error_code, error_message, created_by, created_at, finished_at FROM exports;
DROP TABLE exports;
ALTER TABLE exports_new RENAME TO exports;
CREATE INDEX exports_project ON exports (project_id, created_at DESC);
CREATE INDEX exports_batch ON exports (batch_id);

-- Auto captions / transcripts (Workers AI Whisper) and Resize (FFmpeg), one PostWorkflow each.
CREATE TABLE post_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('captions','transcript','resize')),
  workspace_id TEXT NOT NULL,
  project_id TEXT,
  canvas_id TEXT,
  asset_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','running','done','failed')),
  progress REAL NOT NULL DEFAULT 0,
  params TEXT NOT NULL DEFAULT '{}',
  result TEXT,
  audio_seconds REAL NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX post_jobs_ws ON post_jobs (workspace_id, kind, created_at DESC);
CREATE INDEX post_jobs_project ON post_jobs (project_id, created_at DESC);

-- Where a run's output goes on the timeline (extend: after a clip; lip-sync: replaces a shot).
CREATE TABLE timeline_placements (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL UNIQUE,
  run_id TEXT,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  canvas_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('after','replace')),
  anchor_clip_id TEXT NOT NULL,
  placed_clip_id TEXT,
  seconds REAL NOT NULL,
  previous TEXT,
  status TEXT NOT NULL CHECK (status IN ('quoted','pending','placed','dropped')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX timeline_placements_run ON timeline_placements (run_id);

-- One brand kit per workspace (JSON: logo asset, colors, fonts in R2, cards, watermark, tone).
CREATE TABLE brand_kits (
  workspace_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
