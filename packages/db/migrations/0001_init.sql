-- Yardsign first-slice schema. Timestamps are integer milliseconds since the Unix epoch.
-- See docs/SCHEMA.md for what each table is for.

CREATE TABLE accounts (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  email              TEXT NOT NULL UNIQUE,
  plan               TEXT NOT NULL DEFAULT 'trial',   -- trial | starter | pro
  stripe_customer_id TEXT,
  created_at         INTEGER NOT NULL
);

CREATE TABLE sites (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts(id),
  site_key        TEXT NOT NULL UNIQUE,              -- public; baked into the pixel URL
  name            TEXT NOT NULL,
  allowed_domains TEXT NOT NULL DEFAULT '[]',        -- JSON array of hostnames allowed to POST /collect
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_sites_account ON sites(account_id);

CREATE TABLE visitors (
  id            TEXT NOT NULL,                       -- the browser's _ys_vid cookie
  site_id       TEXT NOT NULL REFERENCES sites(id),
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  visit_count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, id)
);

CREATE TABLE visits (
  id                   TEXT PRIMARY KEY,             -- UUID chosen by the pixel per page view
  site_id              TEXT NOT NULL REFERENCES sites(id),
  visitor_id           TEXT NOT NULL,
  session_id           TEXT NOT NULL,
  url                  TEXT NOT NULL,
  path                 TEXT NOT NULL,
  referrer             TEXT,
  title                TEXT,
  ip_hash              TEXT NOT NULL,                -- sha256(IP_SALT | ip)
  ip_raw               TEXT,                         -- nulled by the cleanup cron after 72 hours
  country              TEXT,
  region               TEXT,
  city                 TEXT,
  postal               TEXT,
  asn                  INTEGER,
  colo                 TEXT,
  lat                  REAL,
  lng                  REAL,
  user_agent           TEXT,
  device               TEXT,                         -- JSON {type, browser, os}
  screen               TEXT,                         -- JSON {w, h, vw, vh, dpr}
  timezone             TEXT,
  language             TEXT,
  bot_score            INTEGER,                      -- Cloudflare bot score 1-99, NULL when the plan has none
  time_on_page_ms      INTEGER,                      -- set by the unload beacon
  occurred_at          INTEGER NOT NULL,             -- browser clock
  created_at           INTEGER NOT NULL,             -- server clock
  resolve_attempted_at INTEGER                       -- set once the resolution step has looked at this visit
);
CREATE INDEX idx_visits_site_time    ON visits(site_id, occurred_at);
CREATE INDEX idx_visits_visitor      ON visits(site_id, visitor_id);
CREATE INDEX idx_visits_unresolved   ON visits(resolve_attempted_at) WHERE resolve_attempted_at IS NULL;
CREATE INDEX idx_visits_ip_raw       ON visits(created_at) WHERE ip_raw IS NOT NULL;

CREATE TABLE identity_requests (
  id               TEXT PRIMARY KEY,
  visit_id         TEXT NOT NULL REFERENCES visits(id),
  provider         TEXT NOT NULL,                    -- mock | delivr
  status           TEXT NOT NULL,                    -- pending | resolved | no_match | error
  request_payload  TEXT,                             -- JSON, what we sent (never the raw IP after 72h; see cleanup)
  response_payload TEXT,                             -- JSON, what came back
  cost_cents       INTEGER,
  created_at       INTEGER NOT NULL,
  completed_at     INTEGER
);
CREATE INDEX idx_idreq_visit  ON identity_requests(visit_id);
CREATE INDEX idx_idreq_status ON identity_requests(status, created_at);

CREATE TABLE leads (
  id                  TEXT PRIMARY KEY,
  site_id             TEXT NOT NULL REFERENCES sites(id),
  visitor_id          TEXT NOT NULL,
  identity_request_id TEXT NOT NULL REFERENCES identity_requests(id),
  first_name          TEXT,
  last_name           TEXT,
  address_line1       TEXT,
  address_line2       TEXT,
  city                TEXT,
  state               TEXT,
  zip                 TEXT,
  phone               TEXT,
  email               TEXT,
  confidence          REAL,                          -- 0..1 from the provider
  lat                 REAL,                          -- geocoded from the address; NULL until geocoding exists
  lng                 REAL,
  linkedin_url        TEXT,
  extra               TEXT NOT NULL DEFAULT '{}',    -- JSON; trade-specific fields (roof_age, year_built) go here later
  created_at          INTEGER NOT NULL
);
CREATE INDEX idx_leads_site_time ON leads(site_id, created_at);
CREATE INDEX idx_leads_visitor   ON leads(site_id, visitor_id, created_at);
CREATE INDEX idx_leads_idreq     ON leads(identity_request_id);

CREATE TABLE deliveries (
  id           TEXT PRIMARY KEY,
  lead_id      TEXT NOT NULL REFERENCES leads(id),
  channel      TEXT NOT NULL,                        -- log | email | webhook | jobnimbus | ...
  status       TEXT NOT NULL,                        -- pending | delivered | failed
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  payload      TEXT,                                 -- JSON, what was (or will be) sent
  created_at   INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE INDEX idx_deliveries_lead   ON deliveries(lead_id);
CREATE INDEX idx_deliveries_status ON deliveries(status, created_at);

CREATE TABLE hail_events (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,                         -- mock | noaa | vendor name
  external_id TEXT NOT NULL,                         -- the source's own id, for upserts
  event_at    INTEGER NOT NULL,
  lat         REAL NOT NULL,
  lng         REAL NOT NULL,
  geom        TEXT,                                  -- JSON polygon/swath when the source gives one
  max_hail_in REAL NOT NULL,
  severity    TEXT,                                  -- minor | moderate | severe
  state       TEXT,
  county      TEXT,
  zip         TEXT,
  raw         TEXT NOT NULL DEFAULT '{}',            -- JSON, the source record as received
  created_at  INTEGER NOT NULL,
  UNIQUE (source, external_id)
);
CREATE INDEX idx_hail_event_at ON hail_events(event_at);
CREATE INDEX idx_hail_state    ON hail_events(state);
CREATE INDEX idx_hail_zip      ON hail_events(zip);
CREATE INDEX idx_hail_latlng   ON hail_events(lat, lng);

CREATE TABLE lead_scores (
  id               TEXT PRIMARY KEY,
  lead_id          TEXT REFERENCES leads(id),        -- NULL for a ZIP-level score taken before identification
  visit_id         TEXT NOT NULL REFERENCES visits(id),
  score            INTEGER NOT NULL,                 -- 0..100
  hail_days_since  REAL,
  hail_max_in      REAL,
  hail_distance_mi REAL,
  components       TEXT NOT NULL DEFAULT '{}',       -- JSON, every input to the formula
  scored_at        INTEGER NOT NULL
);
CREATE INDEX idx_scores_visit ON lead_scores(visit_id, scored_at);
CREATE INDEX idx_scores_lead  ON lead_scores(lead_id, scored_at);

-- Sliding-window rate limiter buckets. See docs/ARCHITECTURE.md.
CREATE TABLE rate_limits (
  key    TEXT NOT NULL,                              -- "site:<site_id>" or "ip:<ip_hash>"
  bucket INTEGER NOT NULL,                           -- floor(now / window_ms)
  count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, bucket)
);
