import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach } from 'vitest';

// Fresh schema + seed once per test file.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

/** Wipe everything but the seeded account and site before every test. */
export async function resetDb(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM lead_scores'),
    env.DB.prepare('DELETE FROM deliveries'),
    env.DB.prepare('DELETE FROM lead_keys'),
    env.DB.prepare('DELETE FROM leads'),
    env.DB.prepare('DELETE FROM identity_requests'),
    env.DB.prepare('DELETE FROM visits'),
    env.DB.prepare('DELETE FROM visitors'),
    env.DB.prepare('DELETE FROM hail_events'),
    env.DB.prepare('DELETE FROM rate_limits'),
    env.DB.prepare('DELETE FROM optouts'),
    env.DB.prepare('DELETE FROM optout_keys'),
    env.DB.prepare('DELETE FROM optout_recalls'),
    env.DB.prepare('DELETE FROM spend_alerts'),
    env.DB.prepare("DELETE FROM sites WHERE id NOT IN ('site_test', 'site_yardsign')"),
    env.DB.prepare("DELETE FROM accounts WHERE id NOT IN ('acct_test', 'acct_yardsign')"),
    env.DB.prepare("UPDATE accounts SET status = 'active', monthly_quota = CASE id WHEN 'acct_yardsign' THEN 0 ELSE 25 END"),
    env.DB.prepare('UPDATE sites SET active = 1, lead_email = NULL'),
  ]);
}

beforeEach(resetDb);
