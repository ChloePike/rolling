-- Migration 0028_trial: the one-time sign-up trial (D-022). Mirrors packages/db/src/d1/schema.ts.
-- One row per new user who signed up after the trial shipped (no retroactive rows): `pending` from the
-- Better Auth user hook, then `granted` or `denied` when the first session is created. Identity signals
-- are SHA-256 hashes only (normalized email, Google subject, client IP, its /24 or /64, device id).
-- Rows outlive account deletion (user_id is pseudonymised), so deleting and signing up again gets no
-- second trial.
CREATE TABLE trial_claims (
  user_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','granted','denied')),
  reason TEXT,
  method TEXT,
  email_hash TEXT,
  google_hash TEXT,
  ip_hash TEXT,
  subnet_hash TEXT,
  device_hash TEXT,
  credits INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX trial_claims_email_granted ON trial_claims (email_hash) WHERE status = 'granted';
CREATE UNIQUE INDEX trial_claims_google_granted ON trial_claims (google_hash) WHERE status = 'granted';
CREATE UNIQUE INDEX trial_claims_workspace_granted ON trial_claims (workspace_id) WHERE status = 'granted';
CREATE INDEX trial_claims_device ON trial_claims (device_hash, status);
CREATE INDEX trial_claims_ip ON trial_claims (ip_hash, status, updated_at);
CREATE INDEX trial_claims_subnet ON trial_claims (subnet_hash, status, updated_at);
CREATE INDEX trial_claims_workspace ON trial_claims (workspace_id, status);
