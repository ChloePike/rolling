-- Migration 0030_collab (D-031): client review links. A link freezes a selection of media
-- (one node version, an export, or the active versions of chosen shots) for reviewers without
-- an account. Reviewers verify their email with a one-time code; their comments live in the
-- project's ProjectRoom (comment_threads with review_id), their decisions here.
-- Mirrors packages/db/src/d1/schema.ts.
CREATE TABLE review_links (
  id TEXT PRIMARY KEY,
  -- Unguessable URL token (/review/<token>); random, not derived from the id.
  token TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('version','export','shots')),
  title TEXT NOT NULL,
  -- JSON ReviewItem[] frozen at creation.
  items TEXT NOT NULL DEFAULT '[]',
  -- 1 when an item is mature and the owner confirmed it (D-005, D-031).
  mature INTEGER NOT NULL DEFAULT 0,
  password_hash TEXT,
  -- Bumped on every password change: signed passes of the old password stop working.
  password_version INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  revoked_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX review_links_project ON review_links (project_id, created_at DESC);

CREATE TABLE review_reviewers (
  id TEXT PRIMARY KEY,
  link_id TEXT NOT NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  -- SHA-256 of the reviewer's bearer token (x-reviewer-token).
  token_hash TEXT NOT NULL UNIQUE,
  verified_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  UNIQUE (link_id, email)
);

CREATE TABLE review_codes (
  link_id TEXT NOT NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (link_id, email)
);

CREATE TABLE review_decisions (
  id TEXT PRIMARY KEY,
  link_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved','changes_requested')),
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX review_decisions_link ON review_decisions (link_id, created_at);
