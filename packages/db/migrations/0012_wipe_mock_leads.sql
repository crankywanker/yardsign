-- One-time cleanup (Oct 7, 2026): remove every fake lead the mock provider made in production,
-- so /admin and the dashboards show only real people. The owner asked for it once identity went live.
-- Removes, in foreign-key order: lead scores and deliveries for those leads, the leads, then the
-- mock lookups themselves (they also inflate "Sent to identification" and the match rate).
-- Visits and ZIP-level scores stay: they were real visits. Delivr rows are untouched.
-- The local test site still uses the mock after this; only rows that exist now are removed.

DELETE FROM lead_scores WHERE lead_id IN (
  SELECT l.id FROM leads l JOIN identity_requests r ON r.id = l.identity_request_id WHERE r.provider = 'mock'
);
DELETE FROM deliveries WHERE lead_id IN (
  SELECT l.id FROM leads l JOIN identity_requests r ON r.id = l.identity_request_id WHERE r.provider = 'mock'
);
DELETE FROM leads WHERE identity_request_id IN (SELECT id FROM identity_requests WHERE provider = 'mock');
DELETE FROM identity_requests WHERE provider = 'mock';
