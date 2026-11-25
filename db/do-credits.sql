-- CreditAccount Durable Object (SQLite). One instance per workspace. Source of truth for credits.
CREATE TABLE balance (id INTEGER PRIMARY KEY CHECK (id = 1), plan INTEGER NOT NULL DEFAULT 0, purchased INTEGER NOT NULL DEFAULT 0, held INTEGER NOT NULL DEFAULT 0, plan_expires_at INTEGER, auto_topup TEXT);
CREATE TABLE ledger (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('grant','purchase','hold','settle','release','refund','expire','adjust')), bucket TEXT NOT NULL CHECK (bucket IN ('plan','purchased')), amount INTEGER NOT NULL, user_id TEXT, run_id TEXT, job_id TEXT, stripe_ref TEXT, idem_key TEXT UNIQUE, created_at INTEGER NOT NULL);
CREATE TABLE holds (job_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, user_id TEXT NOT NULL, from_plan INTEGER NOT NULL, from_purchased INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE quotes (id TEXT PRIMARY KEY, items TEXT NOT NULL, total INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE member_usage (user_id TEXT NOT NULL, month TEXT NOT NULL, spent INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, month));

-- v2 (M2): plan period, auto top-up window, mirror outbox, hold lifecycle, idempotency results.
ALTER TABLE balance ADD COLUMN workspace_id TEXT;
ALTER TABLE balance ADD COLUMN plan_id TEXT;
ALTER TABLE balance ADD COLUMN plan_interval TEXT;
ALTER TABLE balance ADD COLUMN period_start INTEGER;
ALTER TABLE balance ADD COLUMN period_end INTEGER;
ALTER TABLE balance ADD COLUMN auto_topup_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ledger ADD COLUMN note TEXT;
ALTER TABLE ledger ADD COLUMN mirrored_at INTEGER;
CREATE INDEX ledger_unmirrored ON ledger (created_at) WHERE mirrored_at IS NULL;
ALTER TABLE holds ADD COLUMN quote_id TEXT NOT NULL DEFAULT '';
ALTER TABLE holds ADD COLUMN item_ref TEXT NOT NULL DEFAULT '';
ALTER TABLE holds ADD COLUMN model_id TEXT NOT NULL DEFAULT '';
ALTER TABLE holds ADD COLUMN credits INTEGER NOT NULL DEFAULT 0;
ALTER TABLE holds ADD COLUMN plan_expires_at INTEGER;
ALTER TABLE holds ADD COLUMN status TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held','settled','released'));
ALTER TABLE holds ADD COLUMN spent INTEGER;
ALTER TABLE holds ADD COLUMN closed_at INTEGER;
CREATE INDEX holds_status ON holds (status);
CREATE INDEX holds_quote ON holds (quote_id);
ALTER TABLE quotes ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE quotes ADD COLUMN run_id TEXT;
CREATE TABLE idempotency (key TEXT PRIMARY KEY, op TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL);
