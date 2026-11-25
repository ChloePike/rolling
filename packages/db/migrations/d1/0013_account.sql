-- Migration 0013_account: public profiles, avatars, profile publishing on share
-- links, template authorship, invite credit limits, soft-deleted workspaces
-- (account deletion), queued R2 cleanup and user feedback.
-- Mirrors packages/db/src/d1/schema.ts.

-- Handles are stored lowercase; the expression index makes uniqueness case-insensitive
-- even for rows written before normalisation.
CREATE UNIQUE INDEX user_prefs_handle_ci ON user_prefs (lower(handle));
-- Avatar: the R2 key of the derived, safe-rated avatar image and the upload it came from.
ALTER TABLE user_prefs ADD COLUMN avatar_key TEXT;
ALTER TABLE user_prefs ADD COLUMN avatar_asset_id TEXT;

-- "Publish to profile": the share link's cover appears on the author's public profile (D-005 rechecked at read).
ALTER TABLE share_links ADD COLUMN show_on_profile INTEGER NOT NULL DEFAULT 0;
ALTER TABLE share_links ADD COLUMN cover_asset_id TEXT;
-- Share settings: who may open the link (anyone with it, or signed-in members of the workspace) and whether prompts are included.
ALTER TABLE share_links ADD COLUMN audience TEXT NOT NULL DEFAULT 'link' CHECK (audience IN ('link','workspace'));
ALTER TABLE share_links ADD COLUMN show_prompt INTEGER NOT NULL DEFAULT 1;
CREATE INDEX share_links_profile ON share_links (created_by, show_on_profile, created_at DESC);

ALTER TABLE templates ADD COLUMN created_by TEXT;

-- Optional per-member monthly credit limit applied when the invite is accepted.
ALTER TABLE workspace_invites ADD COLUMN monthly_credit_limit INTEGER;

-- Account deletion soft-deletes owned workspaces: the row stays for Stripe webhooks and ledger history.
ALTER TABLE workspaces ADD COLUMN deleted_at INTEGER;

-- R2 prefixes to delete (account deletion), worked through by the sweep cron.
CREATE TABLE r2_cleanup (prefix TEXT PRIMARY KEY, reason TEXT NOT NULL, created_at INTEGER NOT NULL, done_at INTEGER);
CREATE INDEX r2_cleanup_pending ON r2_cleanup (done_at, created_at);

-- Help → Send feedback.
CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  workspace_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('bug','idea','other')),
  message TEXT NOT NULL,
  page TEXT,
  diagnostics TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX feedback_time ON feedback (created_at DESC);
