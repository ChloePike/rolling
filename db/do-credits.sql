-- CreditAccount Durable Object (SQLite). One instance per workspace. Source of truth for credits.
CREATE TABLE balance (id INTEGER PRIMARY KEY CHECK (id = 1), plan INTEGER NOT NULL DEFAULT 0, purchased INTEGER NOT NULL DEFAULT 0, held INTEGER NOT NULL DEFAULT 0, plan_expires_at INTEGER, auto_topup TEXT);
CREATE TABLE ledger (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('grant','purchase','hold','settle','release','refund','expire','adjust')), bucket TEXT NOT NULL CHECK (bucket IN ('plan','purchased')), amount INTEGER NOT NULL, user_id TEXT, run_id TEXT, job_id TEXT, stripe_ref TEXT, idem_key TEXT UNIQUE, created_at INTEGER NOT NULL);
CREATE TABLE holds (job_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, user_id TEXT NOT NULL, from_plan INTEGER NOT NULL, from_purchased INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE quotes (id TEXT PRIMARY KEY, items TEXT NOT NULL, total INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE member_usage (user_id TEXT NOT NULL, month TEXT NOT NULL, spent INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, month));
