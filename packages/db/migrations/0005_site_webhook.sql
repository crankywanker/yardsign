-- Optional webhook delivery per site. kind: json | slack | ghl. NULL url = off.
ALTER TABLE sites ADD COLUMN webhook_url TEXT;
ALTER TABLE sites ADD COLUMN webhook_kind TEXT;
