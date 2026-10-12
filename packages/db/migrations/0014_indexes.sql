-- Indexes for the busy reads that had none (code review, Oct 8, 2026, item 23).
-- Without them, /admin, the dashboard and the cron read whole tables, and /admin gets close to
-- the Worker's CPU limit. Indexes only: no rows change. IF NOT EXISTS makes a re-run harmless.

-- /admin's visit list and chart (last 60 days, every site) and the 13-month cleanup.
-- (idx_visits_ip_raw is on created_at too, but only for rows that still hold a raw IP.)
CREATE INDEX IF NOT EXISTS idx_visits_created ON visits(created_at);

-- Per-site counts by time: the dashboard, /admin's sites table and "last visit".
-- (idx_visits_site_time is on occurred_at, the browser's clock, so these queries could not use it.)
CREATE INDEX IF NOT EXISTS idx_visits_site_created ON visits(site_id, created_at);

-- One session's page views: the engagement gate.
CREATE INDEX IF NOT EXISTS idx_visits_site_session ON visits(site_id, session_id);

-- Lookups by time across every provider and status: /admin's 30-day and 24-hour counts.
-- (The existing indexes start with status or provider, so a plain time range could not use them.)
CREATE INDEX IF NOT EXISTS idx_idreq_created ON identity_requests(created_at);

-- Deliveries by time: /admin's delivery health for the last 7 days.
-- (idx_deliveries_status starts with status.)
CREATE INDEX IF NOT EXISTS idx_deliveries_created ON deliveries(created_at);
