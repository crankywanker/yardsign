-- Bill protection for paid identity providers (Delivr).
-- spend_alerts remembers which "spend crossed X" emails already went out, one row per threshold
-- per month (or per day for the daily cap), so each one is sent once. Key shape:
--   delivr:month:2026-10:50   delivr:month:2026-10:80   delivr:month:2026-10:100   delivr:day:2026-10-07:cap
CREATE TABLE spend_alerts (
  key     TEXT PRIMARY KEY,
  sent_at INTEGER NOT NULL
);

-- The spend cap adds up identity_requests.cost_cents per provider since the start of the month
-- (and of the day) before every paid call. This index keeps that sum cheap.
CREATE INDEX idx_idreq_provider_time ON identity_requests(provider, created_at);
