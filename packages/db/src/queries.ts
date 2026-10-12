/**
 * Thin, typed query helpers over D1. Every function takes the database first so
 * the Worker, the queue consumer and the tests can all share them.
 */
import type {
  AccountRow,
  DeliveryRow,
  DeliveryStatus,
  HailEventRow,
  IdentityRequestRow,
  IdentityRequestStatus,
  LeadFields,
  LeadRow,
  LeadScoreRow,
  SiteRow,
  VisitRow,
  WebhookKind,
} from './types';

export const DAY_MS = 24 * 60 * 60 * 1000;

export function newId(): string {
  return crypto.randomUUID();
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Lowercase, trim, and strip Gmail dots and +tags, then sha256. Used for leads.email_hash and optouts. */
export async function hashEmail(email: string): Promise<string> {
  let e = email.trim().toLowerCase();
  const at = e.indexOf('@');
  if (at > 0) {
    const local = e.slice(0, at);
    const domain = e.slice(at + 1);
    if (domain === 'gmail.com' || domain === 'googlemail.com') e = `${local.split('+')[0]?.replace(/\./g, '') ?? ''}@gmail.com`;
  }
  return sha256Hex(e);
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

// ---------- accounts ----------

export async function getAccount(db: D1Database, id: string): Promise<AccountRow | null> {
  return db.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first<AccountRow>();
}

export async function getAccountByEmail(db: D1Database, email: string): Promise<AccountRow | null> {
  return db.prepare('SELECT * FROM accounts WHERE email = ?').bind(email.toLowerCase()).first<AccountRow>();
}

/** Leads created across all of an account's sites since `sinceMs`. The quota check. Fake people from the mock provider never count. */
export async function countAccountLeadsSince(db: D1Database, accountId: string, sinceMs: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM leads l JOIN sites s ON s.id = l.site_id JOIN identity_requests r ON r.id = l.identity_request_id
       WHERE s.account_id = ? AND l.created_at >= ? AND r.provider != 'mock'`,
    )
    .bind(accountId, sinceMs)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Start of the current calendar month in UTC. */
export function monthStartMs(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** Start of the current day in UTC. */
export function dayStartMs(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// ---------- sites ----------

export interface Site {
  id: string;
  accountId: string;
  siteKey: string;
  name: string;
  allowedDomains: string[];
  active: boolean;
  leadEmail: string | null;
  webhookUrl: string | null;
  webhookKind: WebhookKind | null;
  stripeSessionId: string | null;
  dashKey: string | null;
  delivrPixelId: string | null;
  /** Last time the pixel script was fetched. Null until the tag is on a page. */
  pixelSeenAt: number | null;
  /** Why this paid site waits for the operator (it is off until then). Null = nothing to review. */
  reviewReason: string | null;
  createdAt: number;
}

export function toSite(row: SiteRow): Site {
  return {
    id: row.id,
    accountId: row.account_id,
    siteKey: row.site_key,
    name: row.name,
    allowedDomains: parseJson<string[]>(row.allowed_domains, []),
    active: row.active === 1,
    leadEmail: row.lead_email ?? null,
    webhookUrl: row.webhook_url ?? null,
    webhookKind: row.webhook_kind ?? null,
    stripeSessionId: row.stripe_session_id ?? null,
    dashKey: row.dash_key ?? null,
    delivrPixelId: row.delivr_pixel_id ?? null,
    pixelSeenAt: row.pixel_seen_at ?? null,
    reviewReason: row.review_reason ?? null,
    createdAt: row.created_at,
  };
}

/**
 * Record that the site's pixel script was fetched. Writes at most once per `minGapMs` per site,
 * so a busy page does not turn every script load into a database write.
 */
export async function touchPixelSeen(db: D1Database, siteId: string, now = Date.now(), minGapMs = 5 * 60 * 1000): Promise<boolean> {
  const res = await db
    .prepare('UPDATE sites SET pixel_seen_at = ? WHERE id = ? AND (pixel_seen_at IS NULL OR pixel_seen_at < ?)')
    .bind(now, siteId, now - minGapMs)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** Set or clear the site's Delivr pixel id. Null sends the site back to the mock provider. */
export async function setSiteDelivrPixel(db: D1Database, siteId: string, pixelId: string | null): Promise<void> {
  await db.prepare('UPDATE sites SET delivr_pixel_id = ? WHERE id = ?').bind(pixelId, siteId).run();
}

export async function getSiteByDashKey(db: D1Database, dashKey: string): Promise<Site | null> {
  const row = await db.prepare('SELECT * FROM sites WHERE dash_key = ?').bind(dashKey).first<SiteRow>();
  return row ? toSite(row) : null;
}

export function newDashKey(): string {
  return `dk_${[...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export async function getSiteByStripeSession(db: D1Database, sessionId: string): Promise<Site | null> {
  const row = await db.prepare('SELECT * FROM sites WHERE stripe_session_id = ?').bind(sessionId).first<SiteRow>();
  return row ? toSite(row) : null;
}

export async function getSiteByKey(db: D1Database, siteKey: string): Promise<Site | null> {
  const row = await db.prepare('SELECT * FROM sites WHERE site_key = ?').bind(siteKey).first<SiteRow>();
  return row ? toSite(row) : null;
}

/**
 * The site behind a pixel or a beacon, only when the site is on and its account is active. A cancelled
 * subscription suspends the account, so its pixel goes dark and its visits are dropped.
 */
export async function getLiveSiteByKey(db: D1Database, siteKey: string): Promise<Site | null> {
  const row = await db
    .prepare("SELECT s.* FROM sites s JOIN accounts a ON a.id = s.account_id WHERE s.site_key = ? AND s.active = 1 AND a.status = 'active'")
    .bind(siteKey)
    .first<SiteRow>();
  return row ? toSite(row) : null;
}

export async function getSiteById(db: D1Database, id: string): Promise<Site | null> {
  const row = await db.prepare('SELECT * FROM sites WHERE id = ?').bind(id).first<SiteRow>();
  return row ? toSite(row) : null;
}

export interface NewSite {
  accountId: string;
  siteKey: string;
  name: string;
  allowedDomains: string[];
  leadEmail?: string | null;
  webhookUrl?: string | null;
  webhookKind?: WebhookKind | null;
  stripeSessionId?: string | null;
  /** The subscription that pays for this site. Cancelling it turns this site off. */
  stripeSubscriptionId?: string | null;
  /** Default true. */
  active?: boolean;
  reviewReason?: string | null;
}

export async function insertSite(db: D1Database, s: NewSite, now = Date.now()): Promise<Site> {
  const id = newId();
  const leadEmail = s.leadEmail ?? null;
  const webhookUrl = s.webhookUrl ?? null;
  const webhookKind = webhookUrl ? (s.webhookKind ?? 'json') : null;
  const stripeSessionId = s.stripeSessionId ?? null;
  const active = s.active ?? true;
  const reviewReason = s.reviewReason ?? null;
  const dashKey = newDashKey();
  await db
    .prepare(
      'INSERT INTO sites (id, account_id, site_key, name, allowed_domains, active, lead_email, webhook_url, webhook_kind, stripe_session_id, stripe_subscription_id, review_reason, dash_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(id, s.accountId, s.siteKey, s.name, JSON.stringify(s.allowedDomains), active ? 1 : 0, leadEmail, webhookUrl, webhookKind, stripeSessionId, s.stripeSubscriptionId ?? null, reviewReason, dashKey, now)
    .run();
  return { id, accountId: s.accountId, siteKey: s.siteKey, name: s.name, allowedDomains: s.allowedDomains, active, leadEmail, webhookUrl, webhookKind, stripeSessionId, dashKey, delivrPixelId: null, pixelSeenAt: null, reviewReason, createdAt: now };
}

// ---------- dashboard ----------

/** D1 binds at most 100 values a query, so id lists go in chunks of this size. */
const CHUNK = 90;

/**
 * How far past a lead its "pages viewed" window runs. The visit that made the lead came before it, but
 * its time is the browser clock, which /collect lets run up to 10 minutes ahead of ours.
 */
export const PAGES_AFTER_LEAD_MS = 10 * 60 * 1000;

export async function listLeadsForSite(db: D1Database, siteId: string, limit = 100, sinceMs = 0): Promise<LeadRow[]> {
  const res = await db
    .prepare('SELECT * FROM leads WHERE site_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT ?')
    .bind(siteId, sinceMs, limit)
    .all<LeadRow>();
  return res.results;
}

/** The first `limit` leads made after `sinceMs`, oldest first. The feed pages through these, so a busy hour never skips one. */
export async function listLeadsAfter(db: D1Database, siteId: string, sinceMs: number, limit: number): Promise<LeadRow[]> {
  const res = await db
    .prepare('SELECT * FROM leads WHERE site_id = ? AND created_at > ? ORDER BY created_at ASC, id ASC LIMIT ?')
    .bind(siteId, sinceMs, limit)
    .all<LeadRow>();
  return res.results;
}

/** Latest delivery status per lead id. */
export async function deliveryStatusForLeads(db: D1Database, leadIds: string[]): Promise<Map<string, DeliveryRow>> {
  const out = new Map<string, DeliveryRow>();
  for (let i = 0; i < leadIds.length; i += CHUNK) {
    const chunk = leadIds.slice(i, i + CHUNK);
    const marks = chunk.map(() => '?').join(',');
    const res = await db.prepare(`SELECT * FROM deliveries WHERE lead_id IN (${marks}) ORDER BY created_at ASC`).bind(...chunk).all<DeliveryRow>();
    for (const d of res.results) {
      const prev = out.get(d.lead_id);
      // Prefer a delivered row, then the newest.
      if (!prev || prev.status !== 'delivered') out.set(d.lead_id, d);
    }
  }
  return out;
}

/**
 * Distinct paths each lead's visitor viewed in the `windowMs` before the lead was made, most recent
 * first, keyed by lead id. So an older lead shows what led to it, not what the visitor did today.
 */
export async function pathsForLeads(db: D1Database, siteId: string, leadIds: string[], windowMs = 7 * DAY_MS): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < leadIds.length; i += CHUNK) {
    const chunk = leadIds.slice(i, i + CHUNK);
    const marks = chunk.map(() => '?').join(',');
    const res = await db
      .prepare(
        `SELECT l.id AS lead_id, v.path, MAX(v.occurred_at) AS last FROM leads l JOIN visits v ON v.site_id = l.site_id AND v.visitor_id = l.visitor_id
         WHERE l.site_id = ? AND l.id IN (${marks}) AND v.occurred_at > l.created_at - ? AND v.occurred_at <= l.created_at + ?
         GROUP BY l.id, v.path ORDER BY last DESC`,
      )
      .bind(siteId, ...chunk, windowMs, PAGES_AFTER_LEAD_MS)
      .all<{ lead_id: string; path: string }>();
    for (const r of res.results) {
      const list = out.get(r.lead_id) ?? [];
      if (list.length < 10) list.push(r.path);
      out.set(r.lead_id, list);
    }
  }
  return out;
}

export async function lastVisitAt(db: D1Database, siteId: string): Promise<number | null> {
  const row = await db.prepare('SELECT MAX(created_at) AS t FROM visits WHERE site_id = ?').bind(siteId).first<{ t: number | null }>();
  return row?.t ?? null;
}

/**
 * Retention: visits older than `maxAgeMs` (13 months, as the privacy page says), with their
 * lookups and score rows. Only a visit that led to a lead stays, as long as the lead does.
 */
export async function deleteOldVisits(db: D1Database, maxAgeMs = 395 * DAY_MS, now = Date.now()): Promise<number> {
  const cutoff = now - maxAgeMs;
  const where =
    'created_at < ? AND NOT EXISTS (SELECT 1 FROM identity_requests r JOIN leads l ON l.identity_request_id = r.id WHERE r.visit_id = visits.id)';
  const [, , res] = await db.batch([
    db.prepare(`DELETE FROM lead_scores WHERE visit_id IN (SELECT id FROM visits WHERE ${where})`).bind(cutoff),
    db.prepare(`DELETE FROM identity_requests WHERE visit_id IN (SELECT id FROM visits WHERE ${where})`).bind(cutoff),
    db.prepare(`DELETE FROM visits WHERE ${where}`).bind(cutoff),
  ]);
  return res?.meta.changes ?? 0;
}

export interface SiteDelivery {
  leadEmail: string | null;
  webhookUrl: string | null;
  webhookKind: WebhookKind | null;
}

export async function updateSiteDelivery(db: D1Database, siteId: string, d: SiteDelivery): Promise<void> {
  await db
    .prepare('UPDATE sites SET lead_email = ?, webhook_url = ?, webhook_kind = ? WHERE id = ?')
    .bind(d.leadEmail, d.webhookUrl, d.webhookUrl ? (d.webhookKind ?? 'json') : null, siteId)
    .run();
}

export async function listSites(db: D1Database): Promise<Site[]> {
  const res = await db.prepare('SELECT * FROM sites ORDER BY created_at').all<SiteRow>();
  return res.results.map(toSite);
}

/** Active sites bought through Stripe that still have no Delivr pixel (Delivr was down at checkout). Oldest first. */
export async function listSitesMissingDelivrPixel(db: D1Database, limit = 10): Promise<Site[]> {
  const res = await db
    .prepare('SELECT * FROM sites WHERE active = 1 AND stripe_session_id IS NOT NULL AND delivr_pixel_id IS NULL ORDER BY created_at LIMIT ?')
    .bind(limit)
    .all<SiteRow>();
  return res.results.map(toSite);
}

/**
 * Distinct paths this visitor viewed on this site in the `windowMs` before `now`, most recent first. For the
 * lead card. Pass the lead's created_at as `now` to show what led to an older lead.
 */
export async function listRecentPathsForVisitor(db: D1Database, siteId: string, visitorId: string, windowMs = 7 * DAY_MS, now = Date.now()): Promise<string[]> {
  const res = await db
    .prepare('SELECT path, MAX(occurred_at) AS last FROM visits WHERE site_id = ? AND visitor_id = ? AND occurred_at > ? AND occurred_at <= ? GROUP BY path ORDER BY last DESC LIMIT 20')
    .bind(siteId, visitorId, now - windowMs, now + PAGES_AFTER_LEAD_MS)
    .all<{ path: string; last: number }>();
  return res.results.map((r) => r.path);
}

// ---------- visitors ----------

export async function upsertVisitor(db: D1Database, siteId: string, visitorId: string, now = Date.now()): Promise<void> {
  await db
    .prepare(
      `INSERT INTO visitors (id, site_id, first_seen_at, last_seen_at, visit_count) VALUES (?, ?, ?, ?, 1)
       ON CONFLICT (site_id, id) DO UPDATE SET last_seen_at = excluded.last_seen_at, visit_count = visit_count + 1`,
    )
    .bind(visitorId, siteId, now, now)
    .run();
}

// ---------- visits ----------

export type NewVisit = Omit<VisitRow, 'resolve_attempted_at' | 'time_on_page_ms' | 'skip_reason'>;

export async function insertVisit(db: D1Database, v: NewVisit): Promise<void> {
  await db
    .prepare(
      `INSERT INTO visits (id, site_id, visitor_id, session_id, url, path, referrer, title, ip_hash, ip_raw,
         country, region, city, postal, asn, colo, lat, lng, user_agent, device, screen, timezone, language,
         bot_score, occurred_at, created_at, gpc, asn_org, asn_class)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      v.id, v.site_id, v.visitor_id, v.session_id, v.url, v.path, v.referrer, v.title, v.ip_hash, v.ip_raw,
      v.country, v.region, v.city, v.postal, v.asn, v.colo, v.lat, v.lng, v.user_agent, v.device, v.screen,
      v.timezone, v.language, v.bot_score, v.occurred_at, v.created_at, v.gpc, v.asn_org, v.asn_class,
    )
    .run();
}

export async function getVisit(db: D1Database, id: string): Promise<VisitRow | null> {
  return db.prepare('SELECT * FROM visits WHERE id = ?').bind(id).first<VisitRow>();
}

/** The unload beacon. Scoped to site + visitor so a visitor can only touch their own rows. */
export async function setTimeOnPage(db: D1Database, siteId: string, visitorId: string, visitId: string, ms: number): Promise<boolean> {
  const res = await db
    .prepare('UPDATE visits SET time_on_page_ms = ? WHERE id = ? AND site_id = ? AND visitor_id = ?')
    .bind(ms, visitId, siteId, visitorId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function markResolveAttempted(db: D1Database, visitId: string, now = Date.now(), skipReason: string | null = null): Promise<void> {
  await markResolveAttemptedStmt(db, visitId, now, skipReason).run();
}

/** markResolveAttempted as a statement, for a db.batch with the identity request and lead writes. */
export function markResolveAttemptedStmt(db: D1Database, visitId: string, now = Date.now(), skipReason: string | null = null): D1PreparedStatement {
  return db.prepare('UPDATE visits SET resolve_attempted_at = ?, skip_reason = ? WHERE id = ?').bind(now, skipReason, visitId);
}

export interface UnresolvedVisitFilter {
  /** Only this site's visits. */
  siteId?: string;
  /** Only visits after this one in (created_at, id) order: where the last page stopped. */
  after?: { createdAt: number; id: string } | null;
  /** Only visits created before this time. */
  createdBefore?: number;
}

/** Poll fallback: visits the resolution step has not looked at yet, oldest first. */
export async function listUnresolvedVisits(db: D1Database, limit = 50, f: UnresolvedVisitFilter = {}): Promise<VisitRow[]> {
  const after = f.after ?? null;
  const res = await db
    .prepare(
      `SELECT * FROM visits WHERE resolve_attempted_at IS NULL AND (? IS NULL OR site_id = ?) AND created_at < ?
         AND (? IS NULL OR created_at > ? OR (created_at = ? AND id > ?))
       ORDER BY created_at ASC, id ASC LIMIT ?`,
    )
    .bind(f.siteId ?? null, f.siteId ?? null, f.createdBefore ?? Number.MAX_SAFE_INTEGER, after?.createdAt ?? null, after?.createdAt ?? null, after?.createdAt ?? null, after?.id ?? null, limit)
    .all<VisitRow>();
  return res.results;
}

/** Sites that have visits the resolution step has not looked at yet (created before `createdBefore`). */
export async function listSitesWithUnresolvedVisits(db: D1Database, createdBefore = Number.MAX_SAFE_INTEGER): Promise<string[]> {
  const res = await db
    .prepare('SELECT DISTINCT site_id FROM visits WHERE resolve_attempted_at IS NULL AND created_at < ?')
    .bind(createdBefore)
    .all<{ site_id: string }>();
  return res.results.map((r) => r.site_id);
}

/** Null out raw IPs older than the retention window. Returns rows changed. */
export async function clearExpiredRawIps(db: D1Database, retentionMs = 72 * 60 * 60 * 1000, now = Date.now()): Promise<number> {
  const res = await db
    .prepare('UPDATE visits SET ip_raw = NULL WHERE ip_raw IS NOT NULL AND created_at < ?')
    .bind(now - retentionMs)
    .run();
  return res.meta.changes ?? 0;
}

// ---------- identity requests ----------

/**
 * A match the lead gate withheld (home address outside the allowed states, or no state) keeps its
 * raw answer for at most `retentionMs`. After that only the row count and the reason stay, so the
 * spend estimate and the counts by reason still work. Returns rows changed.
 */
export async function scrubWithheldResponses(db: D1Database, retentionMs = 30 * DAY_MS, now = Date.now()): Promise<number> {
  const res = await db
    .prepare(
      `UPDATE identity_requests
       SET response_payload = json_object('rows', json_extract(response_payload, '$.rows'), 'withheld', json_extract(response_payload, '$.withheld'), 'scrubbed', 1)
       WHERE created_at < ? AND json_extract(response_payload, '$.withheld') IS NOT NULL AND json_extract(response_payload, '$.scrubbed') IS NULL`,
    )
    .bind(now - retentionMs)
    .run();
  return res.meta.changes ?? 0;
}

export async function insertIdentityRequest(
  db: D1Database,
  r: { visitId: string; provider: string; requestPayload: unknown },
  now = Date.now(),
): Promise<string> {
  const id = newId();
  await db
    .prepare('INSERT INTO identity_requests (id, visit_id, provider, status, request_payload, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, r.visitId, r.provider, 'pending', JSON.stringify(r.requestPayload ?? null), now)
    .run();
  return id;
}

/**
 * A pending lookup older than this is presumed dead: its run stopped mid-call. It no longer blocks
 * a new claim, and it counts as billed (at the worst case) for the 24-hour rule and the spend caps.
 */
export const CLAIM_STALE_MS = 10 * 60 * 1000;

/**
 * Claim one provider lookup before paying for it: write the pending identity_requests row, unless
 * this visitor on this site already has a lookup with this provider in flight (pending, newer than
 * CLAIM_STALE_MS) or, for a paid provider, a billed, matched or dead lookup in the last `windowMs`
 * (the 24-hour rule). One statement, so two runs that overlap can never both win.
 * Returns the new row's id, or null when another run got there first.
 */
export async function claimIdentityRequest(
  db: D1Database,
  r: { visitId: string; siteId: string; visitorId: string; provider: string; requestPayload: unknown; billable: boolean },
  now = Date.now(),
  windowMs = DAY_MS,
): Promise<string | null> {
  const id = newId();
  const res = await db
    .prepare(
      `INSERT INTO identity_requests (id, visit_id, provider, status, request_payload, created_at)
       SELECT ?, ?, ?, 'pending', ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM identity_requests p JOIN visits v ON v.id = p.visit_id
         WHERE v.site_id = ? AND v.visitor_id = ? AND p.provider = ?
           AND ((p.status = 'pending' AND p.created_at > ?)
             OR (? = 1 AND p.created_at > ? AND (p.status IN ('resolved', 'pending') OR COALESCE(p.cost_cents, 0) > 0)))
       )`,
    )
    .bind(id, r.visitId, r.provider, JSON.stringify(r.requestPayload ?? null), now, r.siteId, r.visitorId, r.provider, now - CLAIM_STALE_MS, r.billable ? 1 : 0, now - windowMs)
    .run();
  return (res.meta.changes ?? 0) > 0 ? id : null;
}

export async function completeIdentityRequest(
  db: D1Database,
  id: string,
  r: { status: Exclude<IdentityRequestStatus, 'pending'>; responsePayload: unknown; costCents: number | null },
  now = Date.now(),
): Promise<void> {
  await completeIdentityRequestStmt(db, id, r, now).run();
}

/** completeIdentityRequest as a statement, for a db.batch with the visit and lead writes. */
export function completeIdentityRequestStmt(
  db: D1Database,
  id: string,
  r: { status: Exclude<IdentityRequestStatus, 'pending'>; responsePayload: unknown; costCents: number | null },
  now = Date.now(),
): D1PreparedStatement {
  return db
    .prepare('UPDATE identity_requests SET status = ?, response_payload = ?, cost_cents = ?, completed_at = ? WHERE id = ?')
    .bind(r.status, JSON.stringify(r.responsePayload ?? null), r.costCents, now, id);
}

/** True when this visit has a match stored but no lead: an earlier run stopped between the two. */
export async function hasUnfinishedMatch(db: D1Database, visitId: string, provider: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS x FROM identity_requests r WHERE r.visit_id = ? AND r.provider = ? AND r.status = 'resolved'
         AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.identity_request_id = r.id) LIMIT 1`,
    )
    .bind(visitId, provider)
    .first<{ x: number }>();
  return !!row;
}

export async function getIdentityRequest(db: D1Database, id: string): Promise<IdentityRequestRow | null> {
  return db.prepare('SELECT * FROM identity_requests WHERE id = ?').bind(id).first<IdentityRequestRow>();
}

/**
 * What one provider has billed since `sinceMs`, in whole cents. A pending row (a call in flight,
 * or one whose run stopped mid-call) counts as `pendingCents`, the most one call can bill, so a
 * charge whose answer was never stored still counts. The caller adds its own worst case for its call.
 */
export async function sumIdentityCostSince(db: D1Database, provider: string, sinceMs: number, pendingCents = 0): Promise<number> {
  const row = await db
    .prepare(`SELECT COALESCE(SUM(CASE WHEN status = 'pending' THEN ? ELSE cost_cents END), 0) AS cents FROM identity_requests WHERE provider = ? AND created_at >= ?`)
    .bind(pendingCents, provider, sinceMs)
    .first<{ cents: number }>();
  return Number(row?.cents ?? 0);
}

/**
 * The 24-hour rule for paid providers: true when this visitor on this site has a billed identity
 * request (cost_cents > 0), a match, or a dead pending one (older than CLAIM_STALE_MS, maybe billed)
 * newer than `windowMs`. One paid call per visitor per day. A free miss
 * does not count (Oct 8): Delivr usually matches a browser on its second visit, so the return
 * visit must be asked about. With `provider`, only that provider's requests count, so
 * a mock answer from before the flip never blocks the first real lookup.
 */
export async function hadIdentityRequestRecently(db: D1Database, siteId: string, visitorId: string, windowMs = DAY_MS, now = Date.now(), provider?: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS x FROM identity_requests r JOIN visits v ON v.id = r.visit_id
       WHERE v.site_id = ? AND v.visitor_id = ? AND r.created_at > ? AND (? IS NULL OR r.provider = ?)
         AND (r.status = 'resolved' OR COALESCE(r.cost_cents, 0) > 0 OR (r.status = 'pending' AND r.created_at <= ?)) LIMIT 1`,
    )
    .bind(siteId, visitorId, now - windowMs, provider ?? null, provider ?? null, now - CLAIM_STALE_MS)
    .first<{ x: number }>();
  return !!row;
}

export interface SessionEngagement {
  /** Page views stored for this session. */
  views: number;
  /** Longest time on page reported by the unload beacon, in ms. 0 when none arrived. */
  maxTimeOnPageMs: number;
}

/** How much a session looked like a person: how many pages, and the longest stay on one. */
export async function sessionEngagement(db: D1Database, siteId: string, sessionId: string): Promise<SessionEngagement> {
  const row = await db
    .prepare('SELECT COUNT(*) AS views, COALESCE(MAX(time_on_page_ms), 0) AS top FROM visits WHERE site_id = ? AND session_id = ?')
    .bind(siteId, sessionId)
    .first<{ views: number; top: number }>();
  return { views: Number(row?.views ?? 0), maxTimeOnPageMs: Number(row?.top ?? 0) };
}

// ---------- spend alerts ----------

/** Claim a spend alert key. True the first time (send the email), false if it was already sent. */
export async function claimSpendAlert(db: D1Database, key: string, now = Date.now()): Promise<boolean> {
  const res = await db.prepare('INSERT OR IGNORE INTO spend_alerts (key, sent_at) VALUES (?, ?)').bind(key, now).run();
  return (res.meta.changes ?? 0) > 0;
}

/** Give a claim back when the email could not be sent, so the next check tries again. */
export async function releaseSpendAlert(db: D1Database, key: string): Promise<void> {
  await db.prepare('DELETE FROM spend_alerts WHERE key = ?').bind(key).run();
}

/**
 * The 30-day rule. True when this visitor on this site already has a lead, or a
 * non-error identity request, newer than `windowMs`. With `provider`, only leads and
 * requests that provider produced count: a fake person from the mock never stands in for a
 * real lookup, and a real answer is never thrown away because of an earlier fake one.
 */
export async function wasResolvedRecently(
  db: D1Database,
  siteId: string,
  visitorId: string,
  windowMs = 30 * DAY_MS,
  now = Date.now(),
  provider?: string,
): Promise<boolean> {
  const since = now - windowMs;
  const p = provider ?? null;
  const lead = await db
    .prepare(
      `SELECT 1 AS x FROM leads l JOIN identity_requests r ON r.id = l.identity_request_id
       WHERE l.site_id = ? AND l.visitor_id = ? AND l.created_at > ? AND (? IS NULL OR r.provider = ?) LIMIT 1`,
    )
    .bind(siteId, visitorId, since, p, p)
    .first<{ x: number }>();
  if (lead) return true;
  const req = await db
    .prepare(
      `SELECT 1 AS x FROM identity_requests r JOIN visits v ON v.id = r.visit_id
       WHERE v.site_id = ? AND v.visitor_id = ? AND r.status != 'error' AND r.created_at > ? AND (? IS NULL OR r.provider = ?) LIMIT 1`,
    )
    .bind(siteId, visitorId, since, p, p)
    .first<{ x: number }>();
  return !!req;
}

/**
 * What we already know about this visitor on this site from one provider, inside a window:
 * whether any lead was full (a name and a street address), and when we first asked about them
 * (the earliest lead, match or billed request; a free miss does not start the clock, since Delivr
 * usually matches on a return visit). The resolution step uses it for the 30-day rule
 * and the shorter re-check window for email-only matches and misses.
 */
export async function lookupHistory(
  db: D1Database,
  siteId: string,
  visitorId: string,
  since: number,
  provider: string,
): Promise<{ fullLead: boolean; hasLead: boolean; firstAskedAt: number | null }> {
  const leads = await db
    .prepare(
      `SELECT MIN(l.created_at) AS first_at, MAX(l.first_name IS NOT NULL AND l.address_line1 IS NOT NULL) AS full
       FROM leads l JOIN identity_requests r ON r.id = l.identity_request_id
       WHERE l.site_id = ? AND l.visitor_id = ? AND l.created_at > ? AND r.provider = ?`,
    )
    .bind(siteId, visitorId, since, provider)
    .first<{ first_at: number | null; full: number | null }>();
  const reqs = await db
    .prepare(
      `SELECT MIN(r.created_at) AS first_at FROM identity_requests r JOIN visits v ON v.id = r.visit_id
       WHERE v.site_id = ? AND v.visitor_id = ? AND r.status != 'error' AND r.created_at > ? AND r.provider = ?
         AND (r.status = 'resolved' OR COALESCE(r.cost_cents, 0) > 0)`,
    )
    .bind(siteId, visitorId, since, provider)
    .first<{ first_at: number | null }>();
  const times = [leads?.first_at, reqs?.first_at].filter((t): t is number => typeof t === 'number');
  return { fullLead: (leads?.full ?? 0) === 1, hasLead: typeof leads?.first_at === 'number', firstAskedAt: times.length ? Math.min(...times) : null };
}

/**
 * The newest lead for this visitor on this site from one provider, inside a window. With
 * `delivered`, only a lead that reached the business (it has a delivered deliveries row).
 */
export async function latestLeadForVisitor(db: D1Database, siteId: string, visitorId: string, since: number, provider: string, opts: { delivered?: boolean } = {}): Promise<LeadRow | null> {
  return db
    .prepare(
      `SELECT l.* FROM leads l JOIN identity_requests r ON r.id = l.identity_request_id
       WHERE l.site_id = ? AND l.visitor_id = ? AND l.created_at > ? AND r.provider = ?
         AND (? = 0 OR EXISTS (SELECT 1 FROM deliveries d WHERE d.lead_id = l.id AND d.status = 'delivered'))
       ORDER BY l.created_at DESC LIMIT 1`,
    )
    .bind(siteId, visitorId, since, provider, opts.delivered ? 1 : 0)
    .first<LeadRow>();
}

/** True when this visit is the first page view of its session (an earlier view in the same session means no). */
export async function isFirstViewOfSession(db: D1Database, visit: Pick<VisitRow, 'id' | 'site_id' | 'visitor_id' | 'session_id' | 'created_at'>): Promise<boolean> {
  const earlier = await db
    .prepare('SELECT 1 AS x FROM visits WHERE site_id = ? AND visitor_id = ? AND session_id = ? AND id != ? AND created_at <= ? LIMIT 1')
    .bind(visit.site_id, visit.visitor_id, visit.session_id, visit.id, visit.created_at)
    .first<{ x: number }>();
  return !earlier;
}

/** Whether a delivery on this channel went out for any of this visitor's leads since `since`. */
export async function hadDeliverySince(db: D1Database, siteId: string, visitorId: string, channel: string, since: number): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS x FROM deliveries d JOIN leads l ON l.id = d.lead_id
       WHERE l.site_id = ? AND l.visitor_id = ? AND d.channel = ? AND d.created_at > ? LIMIT 1`,
    )
    .bind(siteId, visitorId, channel, since)
    .first<{ x: number }>();
  return !!row;
}

// ---------- leads ----------

export async function insertLead(
  db: D1Database,
  l: {
    siteId: string;
    visitorId: string;
    identityRequestId: string;
    fields: LeadFields;
    confidence: number | null;
    /** Every email and phone the provider returned, beyond the ones on the lead. Kept only as hashes, for opt-outs. */
    contacts?: { emails?: string[]; phones?: string[] };
  },
  now = Date.now(),
): Promise<LeadRow> {
  const { row, stmts } = await insertLeadStmt(db, l, now);
  await db.batch(stmts);
  return row;
}

/** insertLead as statements (the lead and its keys, plus the row it writes), for a db.batch with the identity request and visit writes. */
export async function insertLeadStmt(
  db: D1Database,
  l: Parameters<typeof insertLead>[1],
  now = Date.now(),
): Promise<{ row: LeadRow; stmts: D1PreparedStatement[] }> {
  const id = newId();
  const f = l.fields;
  const row: LeadRow = {
    id,
    site_id: l.siteId,
    visitor_id: l.visitorId,
    identity_request_id: l.identityRequestId,
    first_name: f.first_name ?? null,
    last_name: f.last_name ?? null,
    address_line1: f.address_line1 ?? null,
    address_line2: f.address_line2 ?? null,
    city: f.city ?? null,
    state: f.state ?? null,
    zip: f.zip ?? null,
    phone: f.phone ?? null,
    email: f.email ?? null,
    confidence: l.confidence,
    lat: null,
    lng: null,
    linkedin_url: f.linkedin_url ?? null,
    email_hash: f.email ? await hashEmail(f.email) : null,
    extra: JSON.stringify(f.extra ?? {}),
    created_at: now,
  };
  const keys = await personKeys({
    emails: [f.email, ...(l.contacts?.emails ?? [])],
    phones: [f.phone, ...(l.contacts?.phones ?? [])],
    last_name: f.last_name,
    address_line1: f.address_line1,
    zip: f.zip,
  });
  const stmts = [
    db
      .prepare(
        `INSERT INTO leads (id, site_id, visitor_id, identity_request_id, first_name, last_name, address_line1, address_line2,
           city, state, zip, phone, email, confidence, lat, lng, linkedin_url, email_hash, extra, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.id, row.site_id, row.visitor_id, row.identity_request_id, row.first_name, row.last_name, row.address_line1,
        row.address_line2, row.city, row.state, row.zip, row.phone, row.email, row.confidence, row.lat, row.lng,
        row.linkedin_url, row.email_hash, row.extra, row.created_at,
      ),
    ...[...keys.emailHashes.map((h) => `email:${h}`), ...keys.keys].map((k) =>
      db.prepare('INSERT OR IGNORE INTO lead_keys (lead_id, key) VALUES (?, ?)').bind(row.id, k),
    ),
  ];
  return { row, stmts };
}

// ---------- opt-outs ----------

export async function isOptedOut(db: D1Database, emailHash: string): Promise<boolean> {
  const row = await db.prepare('SELECT 1 AS x FROM optouts WHERE email_hash = ?').bind(emailHash).first<{ x: number }>();
  return !!row;
}

/** What we can recognize a person by, hashed: their emails (as in optouts) and phone and home-address keys. */
export interface PersonKeys {
  emailHashes: string[];
  /** `phone:<sha256>` and `addr:<sha256>`, as in optout_keys and lead_keys. */
  keys: string[];
}

const squash = (s: string | null | undefined): string => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Hash a person's emails, phones and home address the same way at opt-out time and at match time. */
export async function personKeys(p: {
  emails?: Array<string | null | undefined>;
  phones?: Array<string | null | undefined>;
  last_name?: string | null;
  address_line1?: string | null;
  zip?: string | null;
}): Promise<PersonKeys> {
  const emails = [...new Set((p.emails ?? []).filter((e): e is string => !!e && e.includes('@')))];
  const phones = [...new Set((p.phones ?? []).map((x) => (x ?? '').replace(/\D/g, '')).filter((d) => d.length >= 10).map((d) => d.slice(-10)))];
  const keys = await Promise.all(phones.map(async (d) => `phone:${await sha256Hex(d)}`));
  const last = squash(p.last_name);
  const street = squash(p.address_line1);
  const zip = (p.zip ?? '').replace(/\D/g, '').slice(0, 5);
  if (last && street && zip.length === 5) keys.push(`addr:${await sha256Hex(`${last}|${street}|${zip}`)}`);
  return { emailHashes: [...new Set(await Promise.all(emails.map(hashEmail)))], keys };
}

function visitorKey(siteId: string, visitorId: string): string {
  return `visitor:${siteId}:${visitorId}`;
}

/** Has this person opted out, by any of their emails, phones or home address? */
export async function isPersonOptedOut(db: D1Database, k: PersonKeys): Promise<boolean> {
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < k.emailHashes.length; i += 90) {
    const chunk = k.emailHashes.slice(i, i + 90);
    stmts.push(db.prepare(`SELECT 1 AS x FROM optouts WHERE email_hash IN (${chunk.map(() => '?').join(', ')}) LIMIT 1`).bind(...chunk));
  }
  for (let i = 0; i < k.keys.length; i += 90) {
    const chunk = k.keys.slice(i, i + 90);
    stmts.push(db.prepare(`SELECT 1 AS x FROM optout_keys WHERE key IN (${chunk.map(() => '?').join(', ')}) LIMIT 1`).bind(...chunk));
  }
  if (stmts.length === 0) return false;
  const res = await db.batch<{ x: number }>(stmts);
  return res.some((r) => r.results.length > 0);
}

/** Has this browser on this site opted out? Checked before any paid lookup, so we never pay to find them again. */
export async function isVisitorOptedOut(db: D1Database, siteId: string, visitorId: string): Promise<boolean> {
  const row = await db.prepare('SELECT 1 AS x FROM optout_keys WHERE key = ?').bind(visitorKey(siteId, visitorId)).first<{ x: number }>();
  return !!row;
}

/** Remember an opted-out browser on one site. */
export async function rememberOptedOutVisitor(db: D1Database, siteId: string, visitorId: string, now = Date.now()): Promise<void> {
  await db.prepare('INSERT OR IGNORE INTO optout_keys (key, created_at) VALUES (?, ?)').bind(visitorKey(siteId, visitorId), now).run();
}

/** One recall notice: who to tell, and what they need to find the person in their own records. */
export interface OptOutRecall {
  id: string;
  site_name: string;
  /** The site's lead email, else the account owner's email. */
  notify_email: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  city: string | null;
  state: string | null;
  /** When the lead was made. */
  created_at: number;
  attempts: number;
}

/**
 * Record the opt-out, queue a recall notice for every business that could see a lead about the
 * person, and delete those leads in one batch. "Every lead about you" means: any lead holding
 * this email among its emails, and any other lead for the same browser on the same site (an
 * email-only match and its later full card). Their deliveries, address-level scores and keys go
 * too, and the raw provider answers behind that browser are blanked. The person's other emails,
 * phones, home address and browsers are remembered as hashes, so we never identify them again.
 */
export async function optOut(db: D1Database, emailHash: string, now = Date.now()): Promise<{ deleted: number; recallIds: string[] }> {
  type Found = LeadRow & { site_name: string; notify_email: string };
  const leads = (
    await db
      .prepare(
        `SELECT l.*, s.name AS site_name, COALESCE(s.lead_email, a.email) AS notify_email
           FROM leads l JOIN sites s ON s.id = l.site_id JOIN accounts a ON a.id = s.account_id
          WHERE EXISTS (
            SELECT 1 FROM leads m
             WHERE m.site_id = l.site_id AND m.visitor_id = l.visitor_id
               AND (m.email_hash = ?1 OR m.id IN (SELECT lead_id FROM lead_keys WHERE key = 'email:' || ?1)))
          ORDER BY l.created_at`,
      )
      .bind(emailHash)
      .all<Found>()
  ).results;

  const keys = new Set<string>();
  const emailHashes = new Set<string>([emailHash]);
  for (let i = 0; i < leads.length; i += 90) {
    const chunk = leads.slice(i, i + 90).map((l) => l.id);
    const res = await db.prepare(`SELECT key FROM lead_keys WHERE lead_id IN (${chunk.map(() => '?').join(', ')})`).bind(...chunk).all<{ key: string }>();
    for (const r of res.results) {
      if (r.key.startsWith('email:')) emailHashes.add(r.key.slice('email:'.length));
      else keys.add(r.key);
    }
  }
  for (const l of leads) {
    if (l.email_hash) emailHashes.add(l.email_hash);
    keys.add(visitorKey(l.site_id, l.visitor_id));
  }

  const recallIds: string[] = [];
  const stmts: D1PreparedStatement[] = [];
  for (const h of emailHashes) stmts.push(db.prepare('INSERT OR IGNORE INTO optouts (email_hash, created_at) VALUES (?, ?)').bind(h, now));
  for (const k of keys) stmts.push(db.prepare('INSERT OR IGNORE INTO optout_keys (key, created_at) VALUES (?, ?)').bind(k, now));
  const browsers = new Set<string>();
  for (const l of leads) {
    const id = newId();
    recallIds.push(id);
    stmts.push(
      db
        .prepare(
          `INSERT INTO optout_recalls (id, notify_email, site_name, first_name, last_name, email, city, state, lead_created_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, l.notify_email, l.site_name, l.first_name, l.last_name, l.email, l.city, l.state, l.created_at, now),
    );
    stmts.push(db.prepare('DELETE FROM deliveries WHERE lead_id = ?').bind(l.id));
    stmts.push(db.prepare('DELETE FROM lead_scores WHERE lead_id = ?').bind(l.id));
    stmts.push(db.prepare('DELETE FROM lead_keys WHERE lead_id = ?').bind(l.id));
    stmts.push(db.prepare('DELETE FROM leads WHERE id = ?').bind(l.id));
    const browser = `${l.site_id}\n${l.visitor_id}`;
    if (!browsers.has(browser)) {
      browsers.add(browser);
      // Every answer about this browser, withheld ones included, keeps only its row count (the admin page's spend estimate reads it).
      stmts.push(
        db
          .prepare(
            `UPDATE identity_requests SET response_payload = json_object('rows', CASE WHEN json_valid(response_payload) THEN json_extract(response_payload, '$.rows') END, 'opted_out', 1)
              WHERE status = 'resolved' AND visit_id IN (SELECT id FROM visits WHERE site_id = ? AND visitor_id = ?)`,
          )
          .bind(l.site_id, l.visitor_id),
      );
    }
  }
  await db.batch(stmts);
  return { deleted: leads.length, recallIds };
}

/**
 * Recall notices to send: the ones named, or every one due. Due means older than `dueBefore`,
 * not failed `maxAttempts` times, and past its back-off (attempts² × 5 minutes since the last
 * try: 5, 20, 45 minutes and so on, about 8 days in all).
 */
export async function pendingRecalls(db: D1Database, opts: { ids?: string[]; dueBefore?: number; maxAttempts?: number; limit?: number; now?: number }): Promise<OptOutRecall[]> {
  const cols = 'id, site_name, notify_email, first_name, last_name, email, city, state, lead_created_at AS created_at, attempts';
  if (opts.ids) {
    const out: OptOutRecall[] = [];
    for (let i = 0; i < opts.ids.length; i += 90) {
      const chunk = opts.ids.slice(i, i + 90);
      const res = await db.prepare(`SELECT ${cols} FROM optout_recalls WHERE id IN (${chunk.map(() => '?').join(', ')})`).bind(...chunk).all<OptOutRecall>();
      out.push(...res.results);
    }
    return out;
  }
  const res = await db
    .prepare(
      `SELECT ${cols} FROM optout_recalls
        WHERE created_at < ? AND attempts < ? AND (last_attempt_at IS NULL OR last_attempt_at < ? - attempts * attempts * 300000)
        ORDER BY created_at LIMIT ?`,
    )
    .bind(opts.dueBefore ?? Date.now(), opts.maxAttempts ?? 20, opts.now ?? Date.now(), opts.limit ?? 50)
    .all<OptOutRecall>();
  return res.results;
}

/** A recall went out: delete it, so nothing about the person is kept. */
export async function deleteRecalls(db: D1Database, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.batch(ids.map((id) => db.prepare('DELETE FROM optout_recalls WHERE id = ?').bind(id)));
}

/** A recall did not go out: count the try, so the cron backs off and gives up after a while. */
export async function recallFailed(db: D1Database, ids: string[], error: string, now = Date.now()): Promise<void> {
  if (ids.length === 0) return;
  await db.batch(
    ids.map((id) => db.prepare('UPDATE optout_recalls SET attempts = attempts + 1, last_error = ?, last_attempt_at = ? WHERE id = ?').bind(error.slice(0, 500), now, id)),
  );
}

/** Store the geocoded point for a lead's home address. */
export async function updateLeadLocation(db: D1Database, id: string, lat: number, lng: number): Promise<void> {
  await db.prepare('UPDATE leads SET lat = ?, lng = ? WHERE id = ?').bind(lat, lng, id).run();
}

export async function getLead(db: D1Database, id: string): Promise<LeadRow | null> {
  return db.prepare('SELECT * FROM leads WHERE id = ?').bind(id).first<LeadRow>();
}

// ---------- deliveries ----------

export async function insertDelivery(
  db: D1Database,
  d: { leadId: string; channel: string; payload: unknown },
  now = Date.now(),
): Promise<string> {
  const id = newId();
  await db
    .prepare('INSERT INTO deliveries (id, lead_id, channel, status, attempts, payload, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)')
    .bind(id, d.leadId, d.channel, 'pending', JSON.stringify(d.payload ?? null), now)
    .run();
  return id;
}

export async function updateDelivery(
  db: D1Database,
  id: string,
  u: { status: DeliveryStatus; lastError: string | null; deliveredAt: number | null },
): Promise<void> {
  await db
    .prepare('UPDATE deliveries SET status = ?, attempts = attempts + 1, last_error = ?, delivered_at = ? WHERE id = ?')
    .bind(u.status, u.lastError, u.deliveredAt, id)
    .run();
}

export async function listDeliveriesForLead(db: D1Database, leadId: string): Promise<DeliveryRow[]> {
  const res = await db.prepare('SELECT * FROM deliveries WHERE lead_id = ? ORDER BY created_at').bind(leadId).all<DeliveryRow>();
  return res.results;
}

/** A failed delivery the retry job may send again, with what it needs to rebuild the channel. */
export interface RetryableDelivery {
  id: string;
  lead_id: string;
  site_id: string;
  channel: string;
  attempts: number;
  created_at: number;
  provider: string;
  visit_city: string | null;
  visit_region: string | null;
}

/**
 * Failed deliveries that are due another try, oldest first. `dueBefore[n - 1]` is the newest
 * created_at a row with n attempts may have to be due; rows with more attempts than the list
 * covers are left alone. Rows created before `since`, rows whose last_error is `skipError`, and
 * rows whose lead is gone (an opt-out deletes it) are left out.
 */
export async function listRetryableDeliveries(
  db: D1Database,
  o: { since: number; dueBefore: readonly number[]; skipError: string; limit: number },
): Promise<RetryableDelivery[]> {
  if (o.dueBefore.length === 0) return [];
  const due = o.dueBefore.map((_, i) => `WHEN ${i + 1} THEN ?`).join(' ');
  const res = await db
    .prepare(
      `SELECT d.id, d.lead_id, l.site_id, d.channel, d.attempts, d.created_at, r.provider, v.city AS visit_city, v.region AS visit_region
       FROM deliveries d
       JOIN leads l ON l.id = d.lead_id
       JOIN identity_requests r ON r.id = l.identity_request_id
       LEFT JOIN visits v ON v.id = r.visit_id
       WHERE d.status = 'failed' AND d.created_at >= ? AND d.attempts BETWEEN 1 AND ?
         AND COALESCE(d.last_error, '') <> ?
         AND d.created_at <= CASE d.attempts ${due} END
       ORDER BY d.created_at LIMIT ?`,
    )
    .bind(o.since, o.dueBefore.length, o.skipError, ...o.dueBefore, o.limit)
    .all<RetryableDelivery>();
  return res.results;
}

/**
 * Take a failed delivery for another try by moving `attempts` from `seen` to `to` (default one
 * more). False when another run got there first. Pass a bigger `to` to stop retrying it.
 */
export async function claimDeliveryRetry(db: D1Database, id: string, seen: number, to = seen + 1): Promise<boolean> {
  const res = await db.prepare("UPDATE deliveries SET attempts = ? WHERE id = ? AND status = 'failed' AND attempts = ?").bind(to, id, seen).run();
  return (res.meta.changes ?? 0) > 0;
}

/** The outcome of a retry. The try was already counted by claimDeliveryRetry. */
export async function finishDeliveryRetry(
  db: D1Database,
  id: string,
  u: { status: DeliveryStatus; lastError: string | null; deliveredAt: number | null },
): Promise<void> {
  await db.prepare('UPDATE deliveries SET status = ?, last_error = ?, delivered_at = ? WHERE id = ?').bind(u.status, u.lastError, u.deliveredAt, id).run();
}

// ---------- hail events ----------

export type NewHailEvent = Omit<HailEventRow, 'id' | 'created_at'>;

/**
 * Upsert by (source, external_id). Returns how many rows were written.
 * Several rows per statement: D1 caps bound values at 100 per statement and queries per
 * Worker run at 1,000, and a busy Texas spring has more hail reports than that.
 */
export async function upsertHailEvents(db: D1Database, events: NewHailEvent[], now = Date.now()): Promise<number> {
  if (events.length === 0) return 0;
  const rowsPer = 7; // 14 values a row
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < events.length; i += rowsPer) {
    const chunk = events.slice(i, i + rowsPer);
    const values = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
    const binds = chunk.flatMap((e) => [newId(), e.source, e.external_id, e.event_at, e.lat, e.lng, e.geom, e.max_hail_in, e.severity, e.state, e.county, e.zip, e.raw, now]);
    stmts.push(
      db
        .prepare(
          `INSERT INTO hail_events (id, source, external_id, event_at, lat, lng, geom, max_hail_in, severity, state, county, zip, raw, created_at)
           VALUES ${values}
           ON CONFLICT (source, external_id) DO UPDATE SET
             event_at = excluded.event_at, lat = excluded.lat, lng = excluded.lng, geom = excluded.geom,
             max_hail_in = excluded.max_hail_in, severity = excluded.severity, state = excluded.state,
             county = excluded.county, zip = excluded.zip, raw = excluded.raw`,
        )
        .bind(...binds),
    );
  }
  await db.batch(stmts);
  return events.length;
}

/**
 * Hail events inside a lat/lng bounding box since `sinceMs`. The caller still has to
 * check the true distance; the box is just a cheap index-friendly first cut.
 */
export async function listHailEventsInBox(
  db: D1Database,
  box: { minLat: number; maxLat: number; minLng: number; maxLng: number },
  sinceMs: number,
  source: string | null = null,
): Promise<HailEventRow[]> {
  const res = await db
    .prepare(
      'SELECT * FROM hail_events WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ? AND event_at >= ? AND (? IS NULL OR source = ?) ORDER BY event_at DESC',
    )
    .bind(box.minLat, box.maxLat, box.minLng, box.maxLng, sinceMs, source, source)
    .all<HailEventRow>();
  return res.results;
}

/** True when at least one hail event from this source is stored. */
export async function hasHailEventsFrom(db: D1Database, source: string): Promise<boolean> {
  return !!(await db.prepare('SELECT 1 AS x FROM hail_events WHERE source = ? LIMIT 1').bind(source).first<{ x: number }>());
}

/** Delete every hail event from other sources, so fake mock hail never reaches a real card. Returns rows deleted. */
export async function deleteHailEventsNotFrom(db: D1Database, source: string): Promise<number> {
  const res = await db.prepare('DELETE FROM hail_events WHERE source != ?').bind(source).run();
  return res.meta.changes ?? 0;
}

/**
 * Delete this source's events at or after `sinceMs` whose id does not start with `prefix`: rows
 * stored under an id format the source no longer uses. Call it right after a sync of that window,
 * which has just stored the same reports under the new ids. Returns rows deleted.
 */
export async function deleteHailEventsWithOldIds(db: D1Database, source: string, prefix: string, sinceMs: number): Promise<number> {
  const res = await db
    .prepare('DELETE FROM hail_events WHERE source = ? AND event_at >= ? AND substr(external_id, 1, ?) != ?')
    .bind(source, sinceMs, prefix.length, prefix)
    .run();
  return res.meta.changes ?? 0;
}

// ---------- lead scores ----------

export async function insertLeadScore(
  db: D1Database,
  s: Omit<LeadScoreRow, 'id' | 'scored_at'>,
  now = Date.now(),
): Promise<string> {
  const id = newId();
  await db
    .prepare(
      `INSERT INTO lead_scores (id, lead_id, visit_id, score, hail_days_since, hail_max_in, hail_distance_mi, components, scored_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, s.lead_id, s.visit_id, s.score, s.hail_days_since, s.hail_max_in, s.hail_distance_mi, s.components, now)
    .run();
  return id;
}

/** The newest score for each lead, keyed by lead id. Leads never scored are left out. */
export async function latestScoresForLeads(db: D1Database, leadIds: string[]): Promise<Map<string, LeadScoreRow>> {
  const out = new Map<string, LeadScoreRow>();
  for (let i = 0; i < leadIds.length; i += 90) {
    const chunk = leadIds.slice(i, i + 90);
    if (chunk.length === 0) continue;
    const res = await db
      .prepare(`SELECT * FROM lead_scores WHERE lead_id IN (${chunk.map(() => '?').join(', ')}) ORDER BY scored_at ASC`)
      .bind(...chunk)
      .all<LeadScoreRow>();
    for (const r of res.results) if (r.lead_id) out.set(r.lead_id, r);
  }
  return out;
}

export async function latestScoreForVisit(db: D1Database, visitId: string): Promise<LeadScoreRow | null> {
  return db.prepare('SELECT * FROM lead_scores WHERE visit_id = ? ORDER BY scored_at DESC LIMIT 1').bind(visitId).first<LeadScoreRow>();
}

// ---------- admin ----------

export interface VisitWithLead extends VisitRow {
  lead: LeadRow | null;
  identity_status: IdentityRequestStatus | null;
  score: LeadScoreRow | null;
}

/** Recent visits for one site, newest first, with the lead and latest score joined in. */
export async function listRecentVisitsWithLeads(db: D1Database, siteId: string, limit: number): Promise<VisitWithLead[]> {
  const visits = await db
    .prepare('SELECT * FROM visits WHERE site_id = ? ORDER BY occurred_at DESC LIMIT ?')
    .bind(siteId, limit)
    .all<VisitRow>();
  const out: VisitWithLead[] = [];
  for (const v of visits.results) {
    const req = await db
      .prepare('SELECT * FROM identity_requests WHERE visit_id = ? ORDER BY created_at DESC LIMIT 1')
      .bind(v.id)
      .first<IdentityRequestRow>();
    const lead = req ? await db.prepare('SELECT * FROM leads WHERE identity_request_id = ?').bind(req.id).first<LeadRow>() : null;
    const score = await latestScoreForVisit(db, v.id);
    out.push({ ...v, ip_raw: null, lead, identity_status: req?.status ?? null, score });
  }
  return out;
}
