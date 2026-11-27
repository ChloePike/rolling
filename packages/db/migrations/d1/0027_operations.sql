-- Migration 0027_operations (D-025 .. D-030): staff and the admin console, the immutable admin
-- audit log, suspensions and user notices, the trust & safety case queue (safety, reports,
-- appeals, DMCA, child-safety escalation) with locked evidence, the status page probes and
-- incident banner, the gateway circuit breaker, backup runs, and gateway cost per job for the
-- margin dashboard. Mirrors packages/db/src/d1/schema.ts.

-- Staff who may open /admin. Matched by user id, or by verified email (the owner is seeded
-- before their account exists). Roles: admin (everything), reviewer (queue, reports, DMCA, views).
CREATE TABLE staff (
  email TEXT PRIMARY KEY,
  user_id TEXT UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('admin','reviewer')),
  created_at INTEGER NOT NULL,
  created_by TEXT
);
INSERT INTO staff (email, user_id, role, created_at, created_by) VALUES ('phd.chloepike@gmail.com', NULL, 'admin', 0, 'migration:0027');

-- Every admin action (console or ADMIN_TOKEN script). Append-only: triggers refuse UPDATE and DELETE.
CREATE TABLE admin_audit (
  id TEXT PRIMARY KEY,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('staff','token','system')),
  actor_id TEXT,
  actor_role TEXT,
  action TEXT NOT NULL,
  target_kind TEXT,
  target_id TEXT,
  reason TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX admin_audit_time ON admin_audit (created_at DESC);
CREATE INDEX admin_audit_target ON admin_audit (target_kind, target_id, created_at DESC);
CREATE TRIGGER admin_audit_no_update BEFORE UPDATE ON admin_audit BEGIN SELECT RAISE(ABORT, 'admin_audit is append-only'); END;
CREATE TRIGGER admin_audit_no_delete BEFORE DELETE ON admin_audit BEGIN SELECT RAISE(ABORT, 'admin_audit is append-only'); END;

-- Suspensions of a user or a workspace. Active while lifted_at IS NULL: the subject can sign in
-- and browse, but cannot generate or use the agent (403 SUSPENDED).
CREATE TABLE suspensions (
  id TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('user','workspace')),
  subject_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  case_id TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  lifted_at INTEGER,
  lifted_by TEXT
);
CREATE INDEX suspensions_subject ON suspensions (subject_kind, subject_id, lifted_at);

-- Warnings and other notices staff send to a user (shown in the app until dismissed).
CREATE TABLE user_notices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('warning','content_removed','suspended','restored')),
  message TEXT NOT NULL,
  case_id TEXT,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX user_notices_user ON user_notices (user_id, read_at, created_at DESC);

-- The review queue. One open `safety` case per workspace collects its hard-limit events;
-- reports, appeals, DMCA notices and counter-notices are one case each; `child_safety` cases
-- are restricted (admins only) and hold locked evidence and the NCMEC report packet.
CREATE TABLE trust_cases (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('safety','report','appeal','dmca','counter_notice','child_safety')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','actioned','dismissed','closed')),
  priority INTEGER NOT NULL DEFAULT 0,
  workspace_id TEXT,
  user_id TEXT,
  target_kind TEXT,
  target_id TEXT,
  target_url TEXT,
  category TEXT,
  details TEXT,
  reporter_user_id TEXT,
  reporter_email TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  dedupe_key TEXT,
  related_case_id TEXT,
  resolution TEXT,
  resolved_by TEXT,
  resolved_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX trust_cases_queue ON trust_cases (status, priority DESC, created_at);
CREATE INDEX trust_cases_workspace ON trust_cases (workspace_id, created_at DESC);
CREATE INDEX trust_cases_user ON trust_cases (user_id, created_at DESC);
CREATE UNIQUE INDEX trust_cases_open_dedupe ON trust_cases (dedupe_key) WHERE status = 'open' AND dedupe_key IS NOT NULL;

-- Evidence of child-safety cases: copies in the locked private R2 prefix `evidence/` (bucket
-- lock rule, docs/trust-safety.md). Rows cannot be deleted while the case is not closed or the
-- retention period has not passed (18 U.S.C. 2258A(h): one year after the report).
CREATE TABLE evidence_items (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('object','text')),
  r2_key TEXT NOT NULL,
  source_key TEXT NOT NULL,
  sha256 TEXT,
  size INTEGER,
  content_type TEXT,
  captured_at INTEGER NOT NULL,
  retain_until INTEGER NOT NULL,
  UNIQUE (case_id, source_key)
);
CREATE INDEX evidence_items_case ON evidence_items (case_id);
CREATE TRIGGER evidence_items_locked BEFORE DELETE ON evidence_items
WHEN (SELECT status FROM trust_cases WHERE id = OLD.case_id) IS NOT 'closed' OR OLD.retain_until > CAST(strftime('%s','now') AS INTEGER) * 1000
BEGIN SELECT RAISE(ABORT, 'evidence is locked'); END;
CREATE TRIGGER evidence_items_no_update BEFORE UPDATE ON evidence_items BEGIN SELECT RAISE(ABORT, 'evidence is immutable'); END;

-- Status page: one row per probe (every 5 minutes), kept 30 days.
CREATE TABLE status_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  component TEXT NOT NULL CHECK (component IN ('api','gateway','media','auth')),
  ok INTEGER NOT NULL,
  latency_ms INTEGER,
  detail TEXT,
  checked_at INTEGER NOT NULL
);
CREATE INDEX status_checks_component ON status_checks (component, checked_at DESC);

-- Operational settings edited from /admin (incident banner).
CREATE TABLE ops_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

-- Circuit breaker per model gateway (D-030): opens after repeated 5xx or timeouts.
CREATE TABLE gateway_breaker (
  gateway TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'closed' CHECK (state IN ('closed','open')),
  failures INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL DEFAULT 0,
  opened_at INTEGER,
  open_until INTEGER,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);

-- Nightly Durable Object backups (BackupWorkflow): one row per day.
CREATE TABLE backup_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('running','done','failed')),
  credit_accounts INTEGER NOT NULL DEFAULT 0,
  project_rooms INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  pruned INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);

-- Gateway cost of a job in USD (`usage.cost`), for the margin dashboard.
ALTER TABLE jobs ADD COLUMN gateway_cost_usd REAL;
CREATE INDEX jobs_time ON jobs (created_at);

-- The existing hard-limit history lands in the queue: one open safety case per workspace that
-- has hard-limit events, high priority when the workspace is flagged.
INSERT INTO trust_cases (id, kind, status, priority, workspace_id, category, data, dedupe_key, created_at, updated_at)
SELECT 'case_bf' || lower(hex(randomblob(10))), 'safety', 'open',
  CASE WHEN w.safety_flag = 1 THEN 1 ELSE 0 END,
  e.workspace_id, 'hard_limit', '{}', 'safety:' || e.workspace_id, MIN(e.created_at), MAX(e.created_at)
FROM safety_events e LEFT JOIN workspaces w ON w.id = e.workspace_id
WHERE e.hard = 1
GROUP BY e.workspace_id;
