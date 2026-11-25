-- M2: billing (Stripe) and the credit ledger mirror.
-- Times are epoch ms. `subscriptions.id` is the Stripe subscription id.

-- Subscription details read from Stripe (plan comes from the price lookup key).
ALTER TABLE subscriptions ADD COLUMN stripe_price_id TEXT;
ALTER TABLE subscriptions ADD COLUMN current_period_start INTEGER;
CREATE INDEX subscriptions_ws ON subscriptions (workspace_id, current_period_end DESC);

-- Ledger mirror: refund reason / note per line (CreditAccount ledger.note).
ALTER TABLE ledger_lines ADD COLUMN note TEXT;

-- Checkout sessions we created, so the return page can read the outcome and the
-- `resume` quote (the pending run) after the webhook has applied it.
CREATE TABLE checkout_sessions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('plan','topUp')), plan TEXT CHECK (plan IN ('starter','plus','pro')), interval TEXT CHECK (interval IN ('month','year')), amount_cents INTEGER, credits INTEGER, resume_quote_id TEXT, status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','complete','expired')), created_at INTEGER NOT NULL, completed_at INTEGER);
CREATE INDEX checkout_sessions_ws ON checkout_sessions (workspace_id, created_at DESC);
