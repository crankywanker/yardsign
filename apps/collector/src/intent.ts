/**
 * Buying intent from what one visitor did on one site: how many visits (sessions), on how many
 * days, and whether they looked at pages people open when they are close to hiring someone
 * (pricing, financing, insurance claims, a quote, contact or scheduling). Free: it only reads
 * our own visits table.
 */
import { DAY_MS } from '@yardsign/db';

export type IntentLevel = 'high' | 'medium' | 'low';

export interface Intent {
  level: IntentLevel;
  /** Separate visits (sessions). */
  visits: number;
  /** Separate days with a visit (UTC). */
  days: number;
  /** Page views in total. */
  views: number;
  /** High-intent pages the visitor opened, most recent first. */
  keyPages: string[];
}

const KEY_PAGE = /(insur|claim|financ|pric|cost|estimat|quote|contact|schedul|book|inspect|appointment|warrant)/i;

export function isKeyPage(path: string): boolean {
  return KEY_PAGE.test(path);
}

/** Two or more points is medium, three or more is high. */
export function intentLevel(visits: number, days: number, keyPages: number): IntentLevel {
  const points = (visits >= 3 ? 2 : visits >= 2 ? 1 : 0) + (days >= 2 ? 1 : 0) + (keyPages > 0 ? 1 : 0);
  if (points >= 3) return 'high';
  if (points >= 1) return 'medium';
  return 'low';
}

export async function visitorIntent(db: D1Database, siteId: string, visitorId: string, now = Date.now(), windowMs = 30 * DAY_MS): Promise<Intent> {
  const since = now - windowMs;
  const counts = await db
    .prepare(
      `SELECT COUNT(*) AS views, COUNT(DISTINCT session_id) AS visits, COUNT(DISTINCT CAST(created_at / 86400000 AS INTEGER)) AS days
       FROM visits WHERE site_id = ? AND visitor_id = ? AND created_at > ?`,
    )
    .bind(siteId, visitorId, since)
    .first<{ views: number; visits: number; days: number }>();
  const paths = await db
    .prepare('SELECT path, MAX(created_at) AS last FROM visits WHERE site_id = ? AND visitor_id = ? AND created_at > ? GROUP BY path ORDER BY last DESC LIMIT 50')
    .bind(siteId, visitorId, since)
    .all<{ path: string }>();
  const keyPages = paths.results.map((r) => r.path).filter(isKeyPage).slice(0, 5);
  const visits = counts?.visits ?? 0;
  const days = counts?.days ?? 0;
  return { level: intentLevel(visits, days, keyPages.length), visits, days, views: counts?.views ?? 0, keyPages };
}

/** One line for a card: "High: 3 visits over 2 days, looked at /financing, /insurance-claims". */
export function intentLine(i: Intent): string {
  const label = i.level === 'high' ? 'High' : i.level === 'medium' ? 'Medium' : 'Low';
  const visits = `${i.visits} ${i.visits === 1 ? 'visit' : 'visits'}${i.days > 1 ? ` over ${i.days} days` : ''}`;
  const pages = i.keyPages.length ? `, looked at ${i.keyPages.join(', ')}` : '';
  return `${label}: ${visits}${pages}`;
}
