-- When the site's pixel script was last fetched (GET /p/KEY.js), updated at most every few minutes.
-- Proves the tag is on the page even when every visitor is a bot or gets skipped. Read by /admin.
ALTER TABLE sites ADD COLUMN pixel_seen_at INTEGER;
