-- M1: auth (Better Auth), prefs, workspace invites.
--
-- Better Auth tables. Better Auth owns them and writes dates as ISO 8601 text
-- (its SQLite adapter has no native dates); every other D1 table keeps epoch ms.
-- Columns are snake_case through Better Auth's `fields` mapping (apps/api/src/auth/betterAuth.ts).
CREATE TABLE users (id TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, email_verified INTEGER NOT NULL, image TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE sessions (id TEXT NOT NULL PRIMARY KEY, expires_at TEXT NOT NULL, token TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ip_address TEXT, user_agent TEXT, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE TABLE accounts (id TEXT NOT NULL PRIMARY KEY, account_id TEXT NOT NULL, provider_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, access_token TEXT, refresh_token TEXT, id_token TEXT, access_token_expires_at TEXT, refresh_token_expires_at TEXT, scope TEXT, password TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX accounts_user_id_idx ON accounts (user_id);
CREATE TABLE verifications (id TEXT NOT NULL PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX verifications_identifier_idx ON verifications (identifier);

-- Email code resend cooldown (30 s per address). Rows are overwritten on each send.
CREATE TABLE auth_email_sends (email TEXT PRIMARY KEY, last_sent_at INTEGER NOT NULL);

-- user_prefs: confirm_threshold default 300 (D-006), theme (D-010). The table is rebuilt
-- because SQLite cannot change a column default in place. default_model already exists (0001).
CREATE TABLE user_prefs_new (user_id TEXT PRIMARY KEY, language TEXT NOT NULL DEFAULT 'en', currency TEXT NOT NULL DEFAULT 'USD', creation_mode TEXT NOT NULL DEFAULT 'simple', default_ratio TEXT NOT NULL DEFAULT '9:16', default_model TEXT NOT NULL DEFAULT 'auto', confirm_threshold INTEGER NOT NULL DEFAULT 300, notifications TEXT NOT NULL DEFAULT '{"done":true,"low":true,"renewal":true,"product":false}', handle TEXT UNIQUE, bio TEXT, mature_content INTEGER NOT NULL DEFAULT 0, theme TEXT NOT NULL DEFAULT 'system' CHECK (theme IN ('system','light','dark')), updated_at INTEGER NOT NULL DEFAULT 0);
INSERT INTO user_prefs_new (user_id, language, currency, creation_mode, default_ratio, default_model, confirm_threshold, notifications, handle, bio, mature_content)
  SELECT user_id, language, currency, creation_mode, default_ratio, default_model, confirm_threshold, notifications, handle, bio, mature_content FROM user_prefs;
DROP TABLE user_prefs;
ALTER TABLE user_prefs_new RENAME TO user_prefs;

-- Memberships by user (auth middleware, workspace switcher).
CREATE INDEX workspace_members_user ON workspace_members (user_id);

-- Workspace invites. The emailed link carries the raw token; only its SHA-256 is stored.
CREATE TABLE workspace_invites (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, email TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('editor','viewer')), token_hash TEXT NOT NULL UNIQUE, invited_by TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, accepted_at INTEGER, accepted_by TEXT, revoked_at INTEGER);
CREATE INDEX workspace_invites_ws ON workspace_invites (workspace_id, created_at DESC);

-- `test-inbox` email provider (staging end-to-end tests only; refused in production).
-- Rows older than 24 h are deleted on every write and read.
CREATE TABLE test_inbox (id TEXT PRIMARY KEY, to_email TEXT NOT NULL, subject TEXT NOT NULL, text TEXT NOT NULL, code TEXT, template TEXT, sent_at INTEGER NOT NULL);
CREATE INDEX test_inbox_to ON test_inbox (to_email, sent_at DESC);
