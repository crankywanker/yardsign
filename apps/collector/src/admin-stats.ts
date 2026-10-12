/**
 * Numbers for the operator page (/admin). Read-only. Every query here is an aggregate or a
 * narrow select: no raw IPs, no provider extras (income, net worth, married, children). The
 * leads list carries no address, phone or email, and the per-visit explore rows carry no
 * person fields at all.
 */
import { DAY_MS, dayStartMs, deliveryStatusForLeads, monthStartMs, type DeliveryStatus } from '@yardsign/db';
import { parseDevice } from './device';
import { ALLOWED_STATES } from './policy';

/**
 * Delivr's self-serve rates, first volume band (docs/DELIVR.md). Change them here and the
 * estimate on /admin follows. No-matches are free, so only rows that came back are counted.
 */
export const DELIVR_RATES = {
  /** Full-profile rows returned, dollars per 1,000. */
  fullProfileUsdPer1000: 25,
  /** Web events (page views Delivr's pixel captures), dollars per 1,000. */
  webEventUsdPer1000: 0.05,
} as const;

/** Dollars, rounded to the cent. */
export function estimateDelivrUsd(fullProfileRows: number, webEvents: number): number {
  const usd = (fullProfileRows / 1000) * DELIVR_RATES.fullProfileUsdPer1000 + (webEvents / 1000) * DELIVR_RATES.webEventUsdPer1000;
  return Math.round(usd * 100) / 100;
}

export interface ChannelHealth {
  channel: string;
  label: string;
  delivered: number;
  failed: number;
  skipped: number;
}

export interface RecentFailure {
  at: number;
  siteName: string;
  channel: string;
  error: string;
}

export interface SiteSummary {
  id: string;
  name: string;
  siteKey: string;
  active: boolean;
  ownerEmail: string;
  /** Newest of: the pixel script being fetched, a visit being stored. Null = never. */
  installSeenAt: number | null;
  visits30: number;
  sent30: number;
  leads30: number;
  matchRate30: number | null;
  spend30Usd: number;
  channels: string[];
  delivr: boolean;
}

export interface RecentLead {
  id: string;
  at: number;
  siteName: string;
  name: string;
  city: string;
  confidence: number | null;
  status: DeliveryStatus | 'pending';
}

export type VisitOutcome = { kind: OutcomeKind; label: string };

export const OUTCOME_KINDS = ['lead', 'waiting', 'no_match', 'skipped', 'error', 'checked'] as const;
export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

export type DeviceBucket = 'ios' | 'android' | 'desktop' | 'other';

export const DEVICE_LABELS: Record<DeviceBucket, string> = { ios: 'iPhone / iPad', android: 'Android', desktop: 'Desktop', other: 'Other' };

/** iPads on iPadOS 13+ say "Macintosh" and land in Desktop; the page notes say so. */
export function deviceBucket(ua: string | null): DeviceBucket {
  const os = parseDevice(ua).os;
  if (os === 'iOS') return 'ios';
  if (os === 'Android') return 'android';
  if (['Windows', 'macOS', 'ChromeOS', 'Linux'].includes(os)) return 'desktop';
  return 'other';
}

/**
 * Gate 1 skip reasons: the visit was never allowed to reach Delivr. Today's reasons (policy.ts
 * IdentityGateReason) plus the ones the rules before Oct 7, 2026 wrote. Any other skip reason
 * (dedupe, engagement, spend cap, a withheld match) means the visit did pass gate 1.
 */
export const GATE1_SKIPS: readonly string[] = ['bot_or_datacenter', 'gpc', 'non_us', 'region_unknown', 'not_allowed_state', 'outside_us', 'blocked_state', 'mobile', 'relay', 'hosting'];

/** SQL: 1 when visit `v` passed gate 1 (or has not been checked yet), else 0. */
const passedGate1Sql = `(v.skip_reason IS NULL OR v.skip_reason NOT IN (${GATE1_SKIPS.map((r) => `'${r}'`).join(', ')}))`;

export type BrowserFamily = 'chromium' | 'safari' | 'other';

export const BROWSER_FAMILY_LABELS: Record<BrowserFamily, string> = {
  chromium: 'Chrome, Edge and Android',
  safari: 'Safari (iPhone and Mac)',
  other: 'Other browsers',
};

/**
 * Which browser family a user agent belongs to, from parseDevice. Every iPhone and iPad browser
 * runs on Safari's engine (and its cookie rules), so all of iOS counts as Safari, even Chrome on iPhone.
 */
export function browserFamily(ua: string | null): BrowserFamily {
  const d = parseDevice(ua);
  if (d.os === 'iOS' || d.browser === 'Safari') return 'safari';
  if (d.os === 'Android' || ['Chrome', 'Edge', 'Samsung Internet', 'Opera'].includes(d.browser)) return 'chromium';
  return 'other';
}

/** Why a Delivr match did not become a lead, in the order /admin shows them. */
export const WITHHELD_REASONS: ReadonlyArray<{ reason: string; label: string }> = [
  { reason: 'out_of_state_address', label: 'Lives outside Texas' },
  { reason: 'no_address_state', label: 'No state on record' },
  { reason: 'opted_out', label: 'Opted out' },
  { reason: 'low_confidence', label: 'Too unsure to send (low match score)' },
];

/** Something on /admin the operator can act on. Shown only when it is true. */
export interface Attention {
  level: 'bad' | 'warn';
  text: string;
  /** The section of the page that explains it. */
  href: string;
}

/** Delivr spend the way the bill guard counts it (identity_requests.cost_cents), against the caps. */
export interface SpendNow {
  monthCents: number;
  dayCents: number;
  monthCapCents: number;
  dayCapCents: number;
}

/**
 * Every visit of the last EXPLORE_DAYS days on a site that uses Delivr, one compact row each, for the charts and tables
 * the page draws in the browser. No IP, no person fields: strings go into small lookup lists
 * and each row points into them. The visitor is a number, unique per site and browser.
 */
export interface ExploreData {
  now: number;
  since: number;
  /** True when there were more visits than EXPLORE_MAX_ROWS; the oldest were left out. */
  truncated: boolean;
  dict: {
    site: string[];
    /** First 6 characters of the visitor id, per visitor number. */
    tag: string[];
    dev: string[];
    path: string[];
    place: string[];
    net: string[];
    skip: string[];
    why: string[];
    out: string[];
    lead: string[];
    /** Where the visit came from (sourceLabel). */
    src: string[];
  };
  /** See ExploreRow. Oldest first. */
  rows: ExploreRow[];
}

/**
 * [time, visitor, site, browser family (0 Chromium, 1 Safari, 2 other), device bucket
 * (0 iOS, 1 Android, 2 desktop, 3 other), device label, path, place, network, flags,
 * skip reason (-1 none), why a match was not sent (-1 none), outcome kind (OUTCOME_KINDS),
 * outcome label, cost in cents, lead (-1 none), source]. Every index after the time points into dict.
 */
export type ExploreRow = [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number];

/** ExploreRow flags. */
export const FLAG = { eligible: 1, asked: 2, matched: 4, lead: 8, delivrSite: 16 } as const;

export const EXPLORE_DAYS = 60;
export const EXPLORE_MAX_ROWS = 20_000;
const FAMILY_INDEX: Record<BrowserFamily, number> = { chromium: 0, safari: 1, other: 2 };
const DEVICE_INDEX: Record<DeviceBucket, number> = { ios: 0, android: 1, desktop: 2, other: 3 };

export interface AdminStats {
  attention: Attention[];
  spend: SpendNow;
  explore: ExploreData;
  channels: ChannelHealth[];
  failures: RecentFailure[];
  sites: SiteSummary[];
  leads: RecentLead[];
}

/** A visit waiting longer than this for its lookup means the 5-minute check is stuck. Delivr waits 10 minutes on purpose. */
export const STUCK_AFTER_MS = 30 * 60 * 1000;
/** Warn when spend reaches this share of a cap. */
export const SPEND_WARN_SHARE = 0.8;

export const pct = (a: number, b: number): number | null => (b ? Math.round((a / b) * 1000) / 10 : null);

/**
 * The skip reasons of src/policy.ts, in the order the page shows them. The first five are gate 1
 * (before Delivr loads), the next two gate 2 (the lead's home address), then the opt-out.
 * `bot_or_datacenter` is a cost filter, not a privacy rule; it is here so every skip is counted.
 */
export const PRIVACY_GATES: ReadonlyArray<{ reason: string; label: string }> = [
  { reason: 'gpc', label: 'Browser sent Global Privacy Control' },
  { reason: 'non_us', label: 'Outside the US' },
  { reason: 'not_allowed_state', label: 'Visit from outside Texas' },
  { reason: 'region_unknown', label: 'State unknown' },
  { reason: 'bot_or_datacenter', label: 'Bot or data center (cost filter)' },
  { reason: 'out_of_state_address', label: 'Matched, lives outside Texas (not sent)' },
  { reason: 'no_address_state', label: 'Matched, no state on record (not sent)' },
  { reason: 'opted_out', label: 'Opted out' },
];

const OTHER_SKIP_LABELS: Record<string, string> = {
  // Reasons from the rules before Oct 7, 2026. Old visits still carry them.
  outside_us: 'Outside the US (old rule)',
  blocked_state: 'Blocked state (old rule)',
  mobile: 'Cell data (old rule, dropped Oct 7)',
  relay: 'VPN or Private Relay (old rule, dropped Oct 7)',
  hosting: 'Data center (old rule)',
  deduped_30d: 'Already identified in the last 30 days',
  deduped_24h: 'Already asked about in the last 24 hours',
  no_engagement: 'One quiet page view (no second page, under 10 seconds)',
  spend_cap: 'Monthly Delivr spend cap reached',
  daily_spend_cap: 'Daily Delivr spend cap reached',
  spend_check_error: 'Spend check failed (call refused to be safe)',
  account_suspended: 'Subscription ended',
  site_inactive: 'Site turned off',
  over_quota: 'Account over its monthly household limit (not looked up)',
  unfinished_match: 'Match saved but no lead (a run stopped halfway; check the logs)',
};

export const CHANNEL_LABELS: Record<string, string> = {
  email: 'Email',
  'webhook:slack': 'Slack',
  'webhook:ghl': 'GoHighLevel',
  'webhook:json': 'Webhook (plain)',
  log: 'Log only',
};

/** A skip reason in plain words, for the gate cards and the recent-visits list. */
export function skipLabel(reason: string, allowed: readonly string[] = ALLOWED_STATES): string {
  const gate = PRIVACY_GATES.find((g) => g.reason === reason);
  if (gate) {
    const where = allowed.join(', ');
    return where === 'TX' ? gate.label : gate.label.replace('Texas', where);
  }
  return OTHER_SKIP_LABELS[reason] ?? reason;
}

/** What happened to one visit, from its stored columns and its newest identity request. */
export function visitOutcome(
  v: { skip_reason: string | null; resolve_attempted_at: number | null; req_status: string | null; lead_id: string | null },
  allowed: readonly string[] = ALLOWED_STATES,
): VisitOutcome {
  if (v.lead_id) return { kind: 'lead', label: 'Lead' };
  if (v.skip_reason) return { kind: 'skipped', label: skipLabel(v.skip_reason, allowed) };
  if (v.req_status === 'no_match') return { kind: 'no_match', label: 'Looked up, no match' };
  if (v.req_status === 'error') return { kind: 'error', label: 'Lookup failed' };
  if (v.req_status === 'resolved') return { kind: 'checked', label: 'Matched, but too unsure to send' };
  if (v.req_status === 'pending') return { kind: 'waiting', label: 'Lookup in progress' };
  if (v.resolve_attempted_at === null) return { kind: 'waiting', label: 'Waiting (checked every 5 minutes)' };
  return { kind: 'checked', label: 'Checked, nothing found' };
}

/** "iPhone · Safari" from a user agent. */
export function deviceLabel(ua: string | null): string {
  const d = parseDevice(ua);
  const kind = d.os === 'iOS' ? (/ipad/i.test(ua ?? '') ? 'iPad' : 'iPhone') : d.os === 'macOS' ? 'Mac' : d.os;
  return `${kind} · ${d.browser}`;
}

export function channelsForSite(s: { lead_email: string | null; webhook_url: string | null; webhook_kind: string | null }): string[] {
  const out: string[] = [];
  if (s.lead_email) out.push('Email');
  if (s.webhook_url) out.push(CHANNEL_LABELS[`webhook:${s.webhook_kind ?? 'json'}`] ?? 'Webhook');
  return out;
}

type Row = Record<string, number | string | null>;
const num = (v: unknown): number => Number(v ?? 0) || 0;
const str = (x: unknown): string | null => (x === null || x === undefined ? null : String(x));
const dollars = (cents: number): string => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** A list that hands out stable indexes, for the explore lookup lists. */
function indexer(): { list: string[]; at: (s: string) => number } {
  const list: string[] = [];
  const seen = new Map<string, number>();
  return {
    list,
    at(s: string): number {
      let i = seen.get(s);
      if (i === undefined) {
        i = list.length;
        list.push(s);
        seen.set(s, i);
      }
      return i;
    },
  };
}

export interface AdminStatsOptions {
  allowed?: readonly string[];
  now?: number;
  caps?: { monthlyCapCents: number; dailyCapCents: number };
}

export async function adminStats(db: D1Database, opts: AdminStatsOptions = {}): Promise<AdminStats> {
  const allowed = opts.allowed ?? ALLOWED_STATES;
  const now = opts.now ?? Date.now();
  const caps = opts.caps ?? { monthlyCapCents: 125_000, dailyCapCents: 5_000 };
  const d7 = now - 7 * DAY_MS;
  const d30 = now - 30 * DAY_MS;
  const h24 = now - DAY_MS;
  const since = now - EXPLORE_DAYS * DAY_MS;
  const q = (sql: string, ...args: unknown[]) => db.prepare(sql).bind(...args);
  // Rows Delivr returned for one request. The adapter stores the count in the response it keeps; mock rows cost nothing.
  const rowsExpr = `CASE WHEN r.provider = 'delivr' THEN COALESCE(json_extract(r.response_payload, '$.rows'), 0) ELSE 0 END`;
  // A Delivr match: resolved, or a match thrown away because the person opted out (stored as no_match).
  const matchedSql = `(r.status = 'resolved' OR json_extract(r.response_payload, '$.opted_out') IS NOT NULL)`;
  const delivrReq = `FROM identity_requests r WHERE r.visit_id = v.id AND r.provider = 'delivr'`;

  const [spendRow, health, channels, failures, sites, recent, visitRows] = await db.batch<Row>([
    q(
      `SELECT COALESCE(SUM(cost_cents), 0) AS month_cents, COALESCE(SUM(CASE WHEN created_at >= ? THEN cost_cents END), 0) AS day_cents
       FROM identity_requests WHERE provider = 'delivr' AND created_at >= ?`,
      dayStartMs(now), monthStartMs(now),
    ),
    q(
      `SELECT
         (SELECT COUNT(*) FROM identity_requests WHERE status = 'error' AND created_at >= ?1) AS errors_24h,
         (SELECT COUNT(*) FROM visits WHERE resolve_attempted_at IS NULL AND created_at < ?2 AND created_at >= ?3) AS stuck,
         (SELECT COUNT(*) FROM visits WHERE skip_reason IN ('spend_cap', 'daily_spend_cap', 'spend_check_error') AND created_at >= ?1) AS capped_24h,
         (SELECT COUNT(*) FROM deliveries WHERE status = 'failed' AND created_at >= ?1) AS failed_24h,
         (SELECT GROUP_CONCAT(DISTINCT channel) FROM deliveries WHERE status = 'failed' AND created_at >= ?1) AS failed_channels`,
      h24, now - STUCK_AFTER_MS, d7,
    ),
    q('SELECT channel, status, COUNT(*) AS n FROM deliveries WHERE created_at >= ? GROUP BY channel, status', d7),
    q(
      `SELECT d.created_at AS at, d.channel, d.last_error AS error, s.name AS site_name
       FROM deliveries d JOIN leads l ON l.id = d.lead_id JOIN sites s ON s.id = l.site_id
       WHERE d.status = 'failed' AND d.created_at >= ? ORDER BY d.created_at DESC LIMIT 20`,
      d7,
    ),
    q(
      `SELECT s.id, s.name, s.site_key, s.active, s.lead_email, s.webhook_url, s.webhook_kind, s.delivr_pixel_id, s.pixel_seen_at, a.email AS owner_email,
         (SELECT MAX(v.created_at) FROM visits v WHERE v.site_id = s.id) AS last_visit_at,
         (SELECT COUNT(*) FROM visits v WHERE v.site_id = s.id AND v.created_at >= ?) AS visits_30,
         (SELECT COUNT(*) FROM identity_requests r JOIN visits v ON v.id = r.visit_id WHERE v.site_id = s.id AND r.created_at >= ?) AS sent_30,
         (SELECT COUNT(*) FROM leads l WHERE l.site_id = s.id AND l.created_at >= ?) AS leads_30,
         (SELECT SUM(${rowsExpr}) FROM identity_requests r JOIN visits v ON v.id = r.visit_id WHERE v.site_id = s.id AND r.created_at >= ?) AS rows_30
       FROM sites s JOIN accounts a ON a.id = s.account_id ORDER BY s.created_at`,
      d30, d30, d30, d30,
    ),
    q(
      `SELECT l.id, l.created_at AS at, l.first_name, l.last_name, l.city, l.state, l.confidence, s.name AS site_name
       FROM leads l JOIN sites s ON s.id = l.site_id WHERE l.created_at >= ? ORDER BY l.created_at DESC LIMIT 100`,
      d7,
    ),
    // One row per visit on a site that uses Delivr. The funnel steps (asked, matched, lead) count Delivr requests only, so mock never inflates them.
    q(
      `SELECT v.created_at AS at, v.site_id, v.visitor_id, v.user_agent AS ua, v.url, v.referrer, v.path, v.city, v.region, v.asn_org, v.skip_reason, v.resolve_attempted_at,
         s.name AS site_name, s.delivr_pixel_id IS NOT NULL AS delivr_site, ${passedGate1Sql} AS ok1,
         EXISTS (SELECT 1 ${delivrReq}) AS asked,
         EXISTS (SELECT 1 ${delivrReq} AND ${matchedSql}) AS matched,
         EXISTS (SELECT 1 ${delivrReq} AND EXISTS (SELECT 1 FROM leads l WHERE l.identity_request_id = r.id)) AS dlead,
         (SELECT COALESCE(json_extract(r.response_payload, '$.withheld'), CASE WHEN json_extract(r.response_payload, '$.opted_out') IS NOT NULL THEN 'opted_out' END)
            ${delivrReq} AND ${matchedSql} ORDER BY r.created_at DESC LIMIT 1) AS why,
         (SELECT COALESCE(SUM(r.cost_cents), 0) FROM identity_requests r WHERE r.visit_id = v.id) AS cents,
         (SELECT l.id FROM identity_requests r JOIN leads l ON l.identity_request_id = r.id WHERE r.visit_id = v.id LIMIT 1) AS lead_id,
         (SELECT r.status FROM identity_requests r WHERE r.visit_id = v.id ORDER BY r.created_at DESC LIMIT 1) AS req_status
       FROM visits v JOIN sites s ON s.id = v.site_id
       WHERE v.created_at >= ? AND (s.delivr_pixel_id IS NOT NULL OR EXISTS (SELECT 1 ${delivrReq}))
       ORDER BY v.created_at DESC LIMIT ?`,
      since, EXPLORE_MAX_ROWS + 1,
    ),
  ]);

  const sp = spendRow?.results[0] ?? {};
  const spend: SpendNow = { monthCents: num(sp.month_cents), dayCents: num(sp.day_cents), monthCapCents: caps.monthlyCapCents, dayCapCents: caps.dailyCapCents };

  const channelHealth = new Map<string, ChannelHealth>();
  for (const key of Object.keys(CHANNEL_LABELS)) channelHealth.set(key, { channel: key, label: CHANNEL_LABELS[key] ?? key, delivered: 0, failed: 0, skipped: 0 });
  for (const r of channels?.results ?? []) {
    const ch = String(r.channel);
    const h = channelHealth.get(ch) ?? { channel: ch, label: ch, delivered: 0, failed: 0, skipped: 0 };
    const st = String(r.status);
    if (st === 'delivered') h.delivered += num(r.n);
    else if (st === 'failed') h.failed += num(r.n);
    else if (st === 'skipped') h.skipped += num(r.n);
    channelHealth.set(ch, h);
  }

  const siteRows: SiteSummary[] = (sites?.results ?? []).map((r) => {
    const sent30 = num(r.sent_30);
    const leads30 = num(r.leads_30);
    const delivr = r.delivr_pixel_id !== null && r.delivr_pixel_id !== undefined;
    const visits30 = num(r.visits_30);
    const seen = [r.pixel_seen_at, r.last_visit_at].filter((x): x is number => typeof x === 'number');
    return {
      id: String(r.id),
      name: String(r.name),
      siteKey: String(r.site_key),
      active: num(r.active) === 1,
      ownerEmail: String(r.owner_email ?? ''),
      installSeenAt: seen.length ? Math.max(...seen) : null,
      visits30,
      sent30,
      leads30,
      matchRate30: pct(leads30, sent30),
      spend30Usd: estimateDelivrUsd(num(r.rows_30), delivr ? visits30 : 0),
      channels: channelsForSite({ lead_email: r.lead_email as string | null, webhook_url: r.webhook_url as string | null, webhook_kind: r.webhook_kind as string | null }),
      delivr,
    };
  });

  const leadRows = recent?.results ?? [];
  const status = await deliveryStatusForLeads(db, leadRows.map((r) => String(r.id)));
  const leadList: RecentLead[] = leadRows.map((r) => ({
    id: String(r.id),
    at: num(r.at),
    siteName: String(r.site_name),
    name: [r.first_name, r.last_name].filter(Boolean).join(' ') || 'Name not available',
    city: [r.city, r.state].filter(Boolean).join(', ') || '—',
    confidence: r.confidence === null || r.confidence === undefined ? null : Number(r.confidence),
    status: status.get(String(r.id))?.status ?? 'pending',
  }));

  const h = health?.results[0] ?? {};
  return {
    attention: attentionItems({ spend, health: h, sites: siteRows, now }),
    spend,
    explore: exploreData(visitRows?.results ?? [], allowed, now, since),
    channels: [...channelHealth.values()],
    failures: (failures?.results ?? []).map((r) => ({ at: num(r.at), siteName: String(r.site_name), channel: String(r.channel), error: String(r.error ?? '').slice(0, 200) })),
    sites: siteRows,
    leads: leadList,
  };
}

/** The "Needs attention" list: only things that are wrong now and that the operator can do something about. */
export function attentionItems(o: { spend: SpendNow; health: Row; sites: SiteSummary[]; now: number }): Attention[] {
  const out: Attention[] = [];
  const { spend, health, now } = o;
  const failed = num(health.failed_24h);
  if (failed) {
    const chans = String(health.failed_channels ?? '').split(',').filter(Boolean).map((c) => CHANNEL_LABELS[c] ?? c);
    out.push({ level: 'bad', text: `${plural(failed, 'lead delivery', 'lead deliveries')} failed in the last 24 hours${chans.length ? ` (${chans.join(', ')})` : ''}. The roofer may not have the lead.`, href: '#delivery' });
  }
  const capped = num(health.capped_24h);
  if (capped) out.push({ level: 'bad', text: `The Delivr spend cap stopped ${plural(capped, 'lookup')} in the last 24 hours. Those visitors were not looked up.`, href: '#spend' });
  if (spend.dayCapCents && spend.dayCents >= spend.dayCapCents * SPEND_WARN_SHARE) out.push({ level: 'warn', text: `Delivr spend today is ${dollars(spend.dayCents)} of the ${dollars(spend.dayCapCents)} daily cap.`, href: '#spend' });
  if (spend.monthCapCents && spend.monthCents >= spend.monthCapCents * SPEND_WARN_SHARE) out.push({ level: 'warn', text: `Delivr spend this month is ${dollars(spend.monthCents)} of the ${dollars(spend.monthCapCents)} monthly cap.`, href: '#spend' });
  const errors = num(health.errors_24h);
  if (errors) out.push({ level: 'warn', text: `${plural(errors, 'lookup')} failed with an error in the last 24 hours. Look for "Lookup failed" in the visit list.`, href: '#visits' });
  const stuck = num(health.stuck);
  if (stuck) out.push({ level: 'warn', text: `${plural(stuck, 'visit has', 'visits have')} waited more than 30 minutes for a lookup. The 5-minute check may be stuck.`, href: '#visits' });
  for (const s of o.sites) {
    // A real (Delivr) site seen this month but not today went quiet: the tag may have come off the page.
    if (s.active && s.delivr && s.installSeenAt && now - s.installSeenAt > DAY_MS && now - s.installSeenAt < 30 * DAY_MS) {
      out.push({ level: 'warn', text: `${s.name} has had no visits for ${Math.round((now - s.installSeenAt) / 3_600_000)} hours. Check that the tag is still on the site.`, href: '#sites' });
    }
  }
  return out;
}

function parseUrl(u: string | null): URL | null {
  if (!u) return null;
  try {
    return new URL(u);
  } catch {
    return null;
  }
}

/**
 * Where a visit came from, for the "Source" breakdown. The utm tags on the link when it has them
 * ("facebook · paid_social · desktop"), else the site that linked to it, else "No tag, no referrer"
 * (a typed address, a bookmark, or a link opened from a text or an app).
 */
export function sourceLabel(url: string | null, referrer: string | null): string {
  const u = parseUrl(url);
  const tag = (k: string): string => (u?.searchParams.get(k) ?? '').trim().slice(0, 40);
  const source = tag('utm_source');
  if (source) return [source, tag('utm_medium'), tag('utm_content')].filter(Boolean).join(' · ');
  const r = parseUrl(referrer);
  if (!r || !/^https?:$/.test(r.protocol)) return 'No tag, no referrer';
  const host = (x: URL): string => x.hostname.replace(/^www\./, '');
  if (u && host(r) === host(u)) return 'No tag, from another page on the site';
  return `No tag, from ${host(r)}`;
}

/** Turn the visit rows (newest first) into the compact explore payload (oldest first). */
export function exploreData(rows: Row[], allowed: readonly string[], now: number, since: number): ExploreData {
  const truncated = rows.length > EXPLORE_MAX_ROWS;
  const site = indexer();
  const dev = indexer();
  const path = indexer();
  const place = indexer();
  const net = indexer();
  const skip = indexer();
  const why = indexer();
  const out = indexer();
  const lead = indexer();
  const src = indexer();
  const visitors = new Map<string, number>();
  const tag: string[] = [];
  const list = rows.slice(0, EXPLORE_MAX_ROWS).reverse();
  const where = allowed.join(', ');
  const whyLabel = (reason: string): string => {
    const known = WITHHELD_REASONS.find((w) => w.reason === reason);
    if (!known) return skipLabel(reason, allowed);
    return where === 'TX' ? known.label : known.label.replace('Texas', where);
  };
  // Up to 20,000 rows but only a few hundred user agents and links: parse each one once per call.
  const uaCache = new Map<string | null, { family: number; device: number; label: string }>();
  const uaInfo = (ua: string | null) => {
    let hit = uaCache.get(ua);
    if (!hit) {
      hit = { family: FAMILY_INDEX[browserFamily(ua)], device: DEVICE_INDEX[deviceBucket(ua)], label: deviceLabel(ua) };
      uaCache.set(ua, hit);
    }
    return hit;
  };
  const srcCache = new Map<string | null, Map<string | null, string>>();
  const cachedSource = (url: string | null, referrer: string | null): string => {
    let byRef = srcCache.get(url);
    if (!byRef) srcCache.set(url, (byRef = new Map()));
    let label = byRef.get(referrer);
    if (label === undefined) byRef.set(referrer, (label = sourceLabel(url, referrer)));
    return label;
  };
  const explore: ExploreRow[] = list.map((r) => {
    const ua = uaInfo(str(r.ua));
    const vid = str(r.visitor_id) ?? '';
    const vkey = `${String(r.site_id)}|${vid}`;
    let vi = visitors.get(vkey);
    if (vi === undefined) {
      vi = tag.length;
      visitors.set(vkey, vi);
      tag.push(vid.slice(0, 6));
    }
    const skipReason = str(r.skip_reason);
    const asked = num(r.asked) > 0;
    const matched = num(r.matched) > 0;
    const dlead = num(r.dlead) > 0;
    let whyReason: string | null = null;
    if (matched && !dlead) whyReason = str(r.why) ?? (skipReason && ['out_of_state_address', 'no_address_state', 'opted_out'].includes(skipReason) ? skipReason : 'low_confidence');
    const flags = (num(r.ok1) || asked ? FLAG.eligible : 0) | (asked ? FLAG.asked : 0) | (matched ? FLAG.matched : 0) | (dlead ? FLAG.lead : 0) | (num(r.delivr_site) ? FLAG.delivrSite : 0);
    const leadId = str(r.lead_id);
    const outcome = visitOutcome({ skip_reason: skipReason, resolve_attempted_at: r.resolve_attempted_at === null ? null : num(r.resolve_attempted_at), req_status: str(r.req_status), lead_id: leadId }, allowed);
    return [
      num(r.at),
      vi,
      site.at(String(r.site_name)),
      ua.family,
      ua.device,
      dev.at(ua.label),
      path.at(str(r.path) ?? '/'),
      place.at([r.city, r.region].filter(Boolean).join(', ') || 'Unknown'),
      net.at(str(r.asn_org) ?? 'Unknown'),
      flags,
      skipReason ? skip.at(skipLabel(skipReason, allowed)) : -1,
      whyReason ? why.at(whyLabel(whyReason)) : -1,
      OUTCOME_KINDS.indexOf(outcome.kind),
      out.at(outcome.label),
      num(r.cents),
      leadId ? lead.at(leadId) : -1,
      src.at(cachedSource(str(r.url), str(r.referrer))),
    ];
  });
  return {
    now,
    since,
    truncated,
    dict: { site: site.list, tag, dev: dev.list, path: path.list, place: place.list, net: net.list, skip: skip.list, why: why.list, out: out.list, lead: lead.list, src: src.list },
    rows: explore,
  };
}
