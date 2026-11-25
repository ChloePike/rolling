-- Migration 0010_uploads (D-011): resumable chunked uploads. R2's binding cannot list the
-- parts of an open multipart upload, so received parts are recorded here.
CREATE TABLE uploads (
  asset_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  fingerprint TEXT,
  upload_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  part_size INTEGER NOT NULL,
  part_count INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading','complete','aborted','expired')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX uploads_fingerprint ON uploads (workspace_id, user_id, fingerprint, status);
CREATE INDEX uploads_expiry ON uploads (status, expires_at);
CREATE TABLE upload_parts (
  asset_id TEXT NOT NULL REFERENCES uploads(asset_id) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  size INTEGER NOT NULL,
  etag TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (asset_id, n)
);
