/** Dashboard tiles. Everything is "the last 30 days" unless the label says otherwise. */
import { countAccountLeadsSince, monthStartMs } from '@yardsign/db';

export interface Stats {
  visitors: number;
  engaged: number;
  identified: number;
  /** Identified households whose visitor is also engaged. Divided by `engaged` for identifiedPct, so it never passes 100. */
  identifiedEngaged: number;
  identifiedPct: number | null;
  skipped: number;
  skippedPct: number | null;
  topReasons: Array<{ reason: string; n: number }>;
  leads: number;
  delivered: number;
  leadsThisMonth: number;
  usedThisMonth: number;
  lastSeen: number | null;
}

/** "Engaged" means 10+ seconds on a page or 2+ page views. Say it in the UI wherever the number appears. */
export const ENGAGED_MS = 10_000;

const pct = (a: number, b: number): number | null => (b ? Math.round((a / b) * 1000) / 10 : null);

export const SKIP_LABELS: Record<string, string> = {
  gpc: 'browser asked us not to',
  non_us: 'outside the US',
  not_allowed_state: 'outside Texas',
  region_unknown: 'location unknown',
  bot_or_datacenter: 'bot or data center',
  out_of_state_address: 'lives outside Texas',
  no_address_state: 'address incomplete',
  // reasons from before Oct 7, 2026
  outside_us: 'outside the US',
  blocked_state: 'state we skip',
  mobile: 'cell data',
  relay: 'VPN or Private Relay',
  hosting: 'data center',
  deduped_30d: 'already identified this month',
  opted_out: 'opted out',
  account_suspended: 'subscription ended',
  site_inactive: 'site turned off',
  deduped_24h: 'already checked today',
  no_engagement: 'left too fast',
  spend_cap: 'lookup paused',
  daily_spend_cap: 'lookup paused',
  spend_check_error: 'lookup paused',
  over_quota: "over your plan's limit",
  unfinished_match: 'lookup cut off',
  in_progress: 'still being checked',
};

/** A code with no label yet. A customer never sees a raw code. */
export const OTHER_SKIP_LABEL = 'other reason';

export function skipLabel(reason: string): string {
  return SKIP_LABELS[reason] ?? OTHER_SKIP_LABEL;
}

/**
 * Not "skipped on purpose": already checked, left too fast, our own budget limits, or a lookup still running.
 * Left out of that number and its top reasons. Constants only, so they are written into the SQL as is.
 */
export const NOT_ON_PURPOSE = ['deduped_24h', 'deduped_30d', 'spend_cap', 'daily_spend_cap', 'spend_check_error', 'no_engagement', 'in_progress', 'unfinished_match'];
const NOT_ON_PURPOSE_SQL = NOT_ON_PURPOSE.map((r) => `'${r}'`).join(', ');

export async function siteStats(db: D1Database, siteId: string, accountId: string, now = Date.now()): Promise<Stats> {
  const since = now - 30 * 24 * 3600 * 1000;
  const month = monthStartMs(now);
  const q = (sql: string, ...args: unknown[]) => db.prepare(sql).bind(...args);
  const engagedVisitors = `SELECT visitor_id FROM visits WHERE site_id = ? AND created_at >= ?
         GROUP BY visitor_id HAVING COUNT(*) >= 2 OR MAX(COALESCE(time_on_page_ms, 0)) >= ?`;
  const [v, e, idf, ide, sk, reasons, lead, last] = await db.batch<Record<string, number | string | null>>([
    q('SELECT COUNT(DISTINCT visitor_id) AS n FROM visits WHERE site_id = ? AND created_at >= ?', siteId, since),
    q(`SELECT COUNT(*) AS n FROM (${engagedVisitors})`, siteId, since, ENGAGED_MS),
    q('SELECT COUNT(DISTINCT visitor_id) AS n FROM leads WHERE site_id = ? AND created_at >= ?', siteId, since),
    q(
      `SELECT COUNT(DISTINCT visitor_id) AS n FROM leads WHERE site_id = ? AND created_at >= ? AND visitor_id IN (${engagedVisitors})`,
      siteId, since, siteId, since, ENGAGED_MS,
    ),
    q(
      `SELECT COUNT(DISTINCT visitor_id) AS n FROM visits v WHERE site_id = ? AND created_at >= ? AND skip_reason IS NOT NULL
         AND skip_reason NOT IN (${NOT_ON_PURPOSE_SQL}) AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.site_id = v.site_id AND l.visitor_id = v.visitor_id)`,
      siteId, since,
    ),
    q(
      `SELECT skip_reason AS reason, COUNT(DISTINCT visitor_id) AS n FROM visits WHERE site_id = ? AND created_at >= ? AND skip_reason IS NOT NULL AND skip_reason NOT IN (${NOT_ON_PURPOSE_SQL})
         GROUP BY skip_reason ORDER BY n DESC LIMIT 3`,
      siteId, since,
    ),
    q(
      `SELECT COUNT(*) AS leads, SUM(created_at >= ?) AS month,
         SUM(EXISTS (SELECT 1 FROM deliveries d WHERE d.lead_id = leads.id AND d.status = 'delivered')) AS delivered
       FROM leads WHERE site_id = ? AND created_at >= ?`,
      month, siteId, Math.min(since, month),
    ),
    q('SELECT MAX(created_at) AS t FROM visits WHERE site_id = ?', siteId),
  ]);
  const n = (r: D1Result<Record<string, number | string | null>> | undefined, key = 'n'): number => Number(r?.results[0]?.[key] ?? 0);
  const visitors = n(v);
  const engaged = n(e);
  const identified = n(idf);
  const identifiedEngaged = n(ide);
  const skipped = n(sk);
  return {
    visitors,
    engaged,
    identified,
    identifiedEngaged,
    identifiedPct: pct(identifiedEngaged, engaged),
    skipped,
    skippedPct: pct(skipped, visitors),
    topReasons: (reasons?.results ?? []).map((r) => ({ reason: skipLabel(String(r.reason)), n: Number(r.n) })),
    leads: n(lead, 'leads'),
    delivered: n(lead, 'delivered'),
    leadsThisMonth: n(lead, 'month'),
    usedThisMonth: await countAccountLeadsSince(db, accountId, month),
    lastSeen: last?.results[0]?.t === null || last?.results[0]?.t === undefined ? null : Number(last.results[0].t),
  };
}
