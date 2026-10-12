-- One test account and one test site so local dev works right away.
-- Site key TESTKEY is what scripts/smoke.sh and the README use.
INSERT OR IGNORE INTO accounts (id, name, email, plan, created_at)
  VALUES ('acct_test', 'Test Roofing Co', 'test@example.com', 'trial', 1759536000000);
INSERT OR IGNORE INTO sites (id, account_id, site_key, name, allowed_domains, active, created_at)
  VALUES ('site_test', 'acct_test', 'TESTKEY', 'Test site (localhost)', '["localhost","127.0.0.1"]', 1, 1759536000000);
