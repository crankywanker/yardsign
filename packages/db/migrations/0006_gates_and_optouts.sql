-- Signals the resolution step uses to decide whether to try, and why it did not.
ALTER TABLE visits ADD COLUMN gpc INTEGER NOT NULL DEFAULT 0;      -- 1 when the browser sent Sec-GPC: 1
ALTER TABLE visits ADD COLUMN asn_org TEXT;                         -- request.cf.asOrganization
ALTER TABLE visits ADD COLUMN asn_class TEXT;                       -- residential | mobile | business | hosting | relay | unknown
ALTER TABLE visits ADD COLUMN skip_reason TEXT;                     -- set when resolution was skipped on purpose

-- Hashed email on leads so an opt-out can find and delete them without scanning.
ALTER TABLE leads ADD COLUMN email_hash TEXT;
CREATE INDEX idx_leads_email_hash ON leads(email_hash);

-- People who asked us to stop. Only the hash is kept.
CREATE TABLE optouts (
  email_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
