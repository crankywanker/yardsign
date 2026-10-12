-- Per-site dashboard key. v1 login until magic links. Existing rows get one now.
ALTER TABLE sites ADD COLUMN dash_key TEXT;
UPDATE sites SET dash_key = 'dk_' || lower(hex(randomblob(16))) WHERE dash_key IS NULL;
CREATE UNIQUE INDEX idx_sites_dash_key ON sites(dash_key);
