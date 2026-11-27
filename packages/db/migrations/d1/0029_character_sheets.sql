-- Migration 0029_character_sheets (D-032): consistent characters. Mirrors packages/db/src/d1/schema.ts.
-- A character keeps a locked descriptor (face, hair, build, outfit) and a turnaround sheet per
-- version; outfit variants are explicit. Sheet pictures are indexed so runs can tell them apart,
-- consistency checks store a drift score per output, and projects that used a character are listed.
ALTER TABLE characters ADD COLUMN kind TEXT NOT NULL DEFAULT 'person';
-- JSON CharacterDescriptor of the current version (locked: a change makes a new version).
ALTER TABLE characters ADD COLUMN descriptor TEXT;
ALTER TABLE characters ADD COLUMN descriptor_version INTEGER NOT NULL DEFAULT 1;
-- JSON { view: assetId } of the current version's sheet.
ALTER TABLE characters ADD COLUMN sheet TEXT;
-- JSON [{ id, name, outfit, views, runId, createdAt }].
ALTER TABLE characters ADD COLUMN outfits TEXT NOT NULL DEFAULT '[]';
-- D-005: the sheet was drawn from an uploaded photo with a real face; its pictures are never platform assets.
ALTER TABLE characters ADD COLUMN real_face INTEGER NOT NULL DEFAULT 0;
-- R2 key of the reference head crop of the current front view (consistency checks), and its version.
ALTER TABLE characters ADD COLUMN ref_face_key TEXT;
ALTER TABLE characters ADD COLUMN updated_at INTEGER;

CREATE TABLE character_sheet_assets (
  asset_id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  view TEXT NOT NULL,
  outfit_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX character_sheet_assets_char ON character_sheet_assets (character_id, version);

CREATE TABLE character_checks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  character_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  asset_id TEXT NOT NULL,
  run_id TEXT,
  job_id TEXT,
  project_id TEXT,
  score REAL,
  verdict TEXT NOT NULL,
  faces INTEGER NOT NULL DEFAULT 0,
  method TEXT NOT NULL,
  model TEXT,
  cost_usd REAL,
  error TEXT,
  created_at INTEGER NOT NULL,
  CONSTRAINT character_checks_verdict_check CHECK (verdict IN ('consistent','minor','drift','no_face','error'))
);
CREATE INDEX character_checks_char ON character_checks (character_id, created_at DESC);
CREATE INDEX character_checks_asset ON character_checks (asset_id);

CREATE TABLE character_uses (
  character_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  uses INTEGER NOT NULL DEFAULT 1,
  last_used_at INTEGER NOT NULL,
  PRIMARY KEY (character_id, project_id)
);
CREATE INDEX character_uses_ws ON character_uses (workspace_id, last_used_at DESC);
