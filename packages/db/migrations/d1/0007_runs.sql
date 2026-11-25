-- M4 generation: quotes keep the plan, runs keep totals and options, run_items
-- hold each planned node until its inputs land and a job slot is free, jobs
-- gain workspace/attempt/asset columns, and provider webhooks are deduped.
-- Times are epoch ms.

ALTER TABLE quotes ADD COLUMN created_by TEXT;
ALTER TABLE quotes ADD COLUMN scope TEXT;
ALTER TABLE quotes ADD COLUMN created_at INTEGER;

ALTER TABLE runs ADD COLUMN title TEXT;
ALTER TABLE runs ADD COLUMN source TEXT NOT NULL DEFAULT 'canvas';
ALTER TABLE runs ADD COLUMN credits_quoted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN credits_spent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN credits_refunded INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN options TEXT NOT NULL DEFAULT '{}';
ALTER TABLE runs ADD COLUMN updated_at INTEGER;
ALTER TABLE runs ADD COLUMN finished_at INTEGER;
CREATE INDEX runs_ws ON runs (workspace_id, created_at DESC);

-- One row per `run` item of the quote. `spec` is the frozen GenSpec; `depends_on`
-- the item refs whose outputs are inputs here.
CREATE TABLE run_items (
  run_id TEXT NOT NULL REFERENCES runs(id),
  ref TEXT NOT NULL,
  node_id TEXT,
  title TEXT,
  kind TEXT NOT NULL,
  model TEXT NOT NULL,
  spec TEXT NOT NULL,
  price_request TEXT NOT NULL DEFAULT '{}',
  params_hash TEXT,
  depends_on TEXT NOT NULL DEFAULT '[]',
  credits INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed','skipped','canceled')),
  job_id TEXT,
  error_code TEXT,
  error_message TEXT,
  ord INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, ref)
);
CREATE INDEX run_items_pending ON run_items (status, run_id);

ALTER TABLE jobs ADD COLUMN workspace_id TEXT;
ALTER TABLE jobs ADD COLUMN item_ref TEXT;
ALTER TABLE jobs ADD COLUMN created_by TEXT;
ALTER TABLE jobs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;
ALTER TABLE jobs ADD COLUMN asset_id TEXT;
ALTER TABLE jobs ADD COLUMN error_message TEXT;
ALTER TABLE jobs ADD COLUMN updated_at INTEGER;
CREATE INDEX jobs_ws ON jobs (workspace_id, created_at DESC);

CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  event_type TEXT NOT NULL,
  external_id TEXT,
  received_at INTEGER NOT NULL
);
