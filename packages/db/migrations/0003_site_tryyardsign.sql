-- The founder's own site. tryyardsign.com runs the same pixel as every customer (the flywheel).
INSERT OR IGNORE INTO accounts (id, name, email, plan, created_at)
  VALUES ('acct_yardsign', 'Yardsign', 'owner@example.com', 'pro', 1759622400000);
INSERT OR IGNORE INTO sites (id, account_id, site_key, name, allowed_domains, active, created_at)
  VALUES ('site_yardsign', 'acct_yardsign', 'TRYYARDSIGN', 'tryyardsign.com', '["tryyardsign.com"]', 1, 1759622400000);
