-- A Stripe subscription belongs to the site it paid for, not to the whole account.
-- Cancelling it turns off that site only (sites.active = 0), never the account.
-- Stripe has never been live, so no existing row has a subscription to copy over.
ALTER TABLE sites ADD COLUMN stripe_subscription_id TEXT;
CREATE INDEX idx_sites_subscription ON sites(stripe_subscription_id);

-- Why a paid site is waiting for the operator, e.g. the checkout email belongs to an account
-- with a different Stripe customer. Such a site is created off (active = 0); NULL = nothing to review.
ALTER TABLE sites ADD COLUMN review_reason TEXT;
