-- Opt-outs that stick, and recall notices that are not lost (code review, Oct 8, items 1, 2, 3 and 12).

-- Hashes of every email, phone and home address we know for a lead, so an opt-out with any of
-- the person's emails finds every lead about them. Deleted with the lead.
--   email:<same hash as leads.email_hash>  phone:<sha256 of the last 10 digits>  addr:<sha256 of last name|street|zip5>
CREATE TABLE lead_keys (
  lead_id TEXT NOT NULL REFERENCES leads(id),
  key     TEXT NOT NULL,
  PRIMARY KEY (lead_id, key)
);
CREATE INDEX idx_lead_keys_key ON lead_keys(key);
INSERT OR IGNORE INTO lead_keys (lead_id, key) SELECT id, 'email:' || email_hash FROM leads WHERE email_hash IS NOT NULL;

-- More ways to recognize someone who opted out, besides the email they typed (that stays in optouts):
--   visitor:<site_id>:<visitor_id>  a browser on one site; checked before any paid lookup
--   phone:<sha256 of the last 10 digits>
--   addr:<sha256 of last name|street|zip5>
-- Only hashes and our own random ids are kept, never the person's details.
CREATE TABLE optout_keys (
  key        TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

-- Recall notices waiting to go out. A row holds just what the business needs to find the person
-- in its own records, and is deleted the moment the email is sent. The cron retries failures.
CREATE TABLE optout_recalls (
  id              TEXT PRIMARY KEY,
  notify_email    TEXT NOT NULL,
  site_name       TEXT NOT NULL,
  first_name      TEXT,
  last_name       TEXT,
  email           TEXT,
  city            TEXT,
  state           TEXT,
  lead_created_at INTEGER NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  last_attempt_at INTEGER
);
CREATE INDEX idx_optout_recalls_time ON optout_recalls(created_at);

-- We no longer ask Delivr for age, income, net worth, marital status or children. Remove what
-- earlier lookups stored: on leads, in what was sent to customers, and in the raw answers.
UPDATE leads
   SET extra = json_remove(extra, '$.is_married', '$.has_children', '$.age_range', '$.income_range', '$.net_worth')
 WHERE json_valid(extra);
UPDATE deliveries
   SET payload = json_remove(payload, '$.extra.is_married', '$.extra.has_children', '$.extra.age_range', '$.extra.income_range', '$.extra.net_worth')
 WHERE json_valid(payload);
UPDATE identity_requests
   SET response_payload = json_remove(response_payload, '$.row.is_married', '$.row.has_children', '$.row.age_range', '$.row.income_range_lc', '$.row.net_worth')
 WHERE json_valid(response_payload) AND json_type(response_payload, '$.row') = 'object';
