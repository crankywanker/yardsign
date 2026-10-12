-- Billing fields. Accounts created by Stripe Checkout; sites remember the session that made them.
ALTER TABLE accounts ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE accounts ADD COLUMN monthly_quota INTEGER NOT NULL DEFAULT 25;   -- identified households per month; 0 = unlimited
ALTER TABLE accounts ADD COLUMN status TEXT NOT NULL DEFAULT 'active';       -- active | suspended
ALTER TABLE sites ADD COLUMN stripe_session_id TEXT;                          -- idempotency key for provisioning
CREATE UNIQUE INDEX idx_sites_stripe_session ON sites(stripe_session_id);
CREATE INDEX idx_accounts_subscription ON accounts(stripe_subscription_id);

-- The founder's own account is not metered.
UPDATE accounts SET plan = 'pro', monthly_quota = 0 WHERE id = 'acct_yardsign';
