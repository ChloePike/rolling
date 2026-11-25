-- D-013: Team plan with purchased seats. SQLite cannot change a CHECK constraint
-- in place, so `subscriptions` and `checkout_sessions` are rebuilt to allow
-- plan 'team'. `seats` = members including the owner (Stripe seat quantity + 1);
-- personal plans keep 1.
CREATE TABLE subscriptions_new (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), plan TEXT NOT NULL CHECK (plan IN ('starter','plus','pro','team')), interval TEXT NOT NULL CHECK (interval IN ('month','year')), status TEXT NOT NULL, current_period_end INTEGER NOT NULL, cancel_at_period_end INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, stripe_price_id TEXT, current_period_start INTEGER, seats INTEGER NOT NULL DEFAULT 1 CHECK (seats >= 1));
INSERT INTO subscriptions_new (id, workspace_id, plan, interval, status, current_period_end, cancel_at_period_end, updated_at, stripe_price_id, current_period_start)
  SELECT id, workspace_id, plan, interval, status, current_period_end, cancel_at_period_end, updated_at, stripe_price_id, current_period_start FROM subscriptions;
DROP TABLE subscriptions;
ALTER TABLE subscriptions_new RENAME TO subscriptions;
CREATE INDEX subscriptions_ws ON subscriptions (workspace_id, current_period_end DESC);

CREATE TABLE checkout_sessions_new (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('plan','topUp')), plan TEXT CHECK (plan IN ('starter','plus','pro','team')), interval TEXT CHECK (interval IN ('month','year')), amount_cents INTEGER, credits INTEGER, resume_quote_id TEXT, status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','complete','expired')), created_at INTEGER NOT NULL, completed_at INTEGER, seats INTEGER);
INSERT INTO checkout_sessions_new (id, workspace_id, user_id, kind, plan, interval, amount_cents, credits, resume_quote_id, status, created_at, completed_at)
  SELECT id, workspace_id, user_id, kind, plan, interval, amount_cents, credits, resume_quote_id, status, created_at, completed_at FROM checkout_sessions;
DROP TABLE checkout_sessions;
ALTER TABLE checkout_sessions_new RENAME TO checkout_sessions;
CREATE INDEX checkout_sessions_ws ON checkout_sessions (workspace_id, created_at DESC);
