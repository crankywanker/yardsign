/**
 * The customer dashboard. v1 login: ?key= is the site's dash_key (that site only) or
 * ADMIN_TOKEN (every site; pick one with ?site=). Magic links replace this after Oct 30.
 */
import { Hono } from 'hono';
import {
  deliveryStatusForLeads,
  getAccount,
  getSiteByDashKey,
  getSiteById,
  lastVisitAt,
  latestScoresForLeads,
  listLeadsAfter,
  listLeadsForSite,
  listSites,
  pathsForLeads,
  updateSiteDelivery,
  type LeadRow,
  type Site,
  type WebhookKind,
} from '@yardsign/db';
import { getDeliveryChannels, toLeadPayload } from '../delivery';
import type { Env } from '../env';
import { safeEqual } from '../hash';
import type { Logger } from '../log';
import { hailFactsFromScore, hailJson } from '../email/hail';
import { dashboardPage, deliveryPage, deniedPage, installPage, loginPage, sortLeads, type DashCtx, type LeadView } from '../pages/dashboard';
import { APP_NAME } from '../plans';
import { HOURLY_KEY_PREFIX, HOUR_MS, checkRateLimit } from '../rate-limit';
import { siteStats } from '../stats';
import { isValidSiteKey } from '../validate';
import { isAllowedWebhookUrl } from '../webhook';
import { publicBaseUrl } from './site';

type Vars = { log: Logger; requestId: string };
export const appRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

appRoutes.use('/app', async (c, next) => {
  await next();
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Cache-Control', 'no-store');
});
appRoutes.use('/app/*', async (c, next) => {
  await next();
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Cache-Control', 'no-store');
});

function isAdminKey(env: Env, key: string): boolean {
  return !!env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= 8 && safeEqual(key, env.ADMIN_TOKEN);
}

async function auth(env: Env, url: string, key: string, wantSite: string | undefined): Promise<DashCtx | null> {
  if (!key) return null;
  const admin = isAdminKey(env, key);
  let site: Site | null = null;
  let sites: Array<{ id: string; name: string }> = [];
  if (admin) {
    const all = await listSites(env.DB);
    sites = all.map((s) => ({ id: s.id, name: s.name }));
    // A ?site= that matches nothing (a typo) is an error, never another site's leads.
    site = wantSite ? (all.find((s) => s.id === wantSite) ?? null) : (all[0] ?? null);
  } else if (key.startsWith('dk_') && key.length >= 20) {
    site = await getSiteByDashKey(env.DB, key);
  }
  if (!site) return null;
  const account = await getAccount(env.DB, site.accountId);
  if (!account) return null;
  const print = new URL(url).searchParams.get('print') === '1';
  return { app: APP_NAME, baseUrl: publicBaseUrl(env, url), key, admin, site, account, sites, mock: (env.IDENTITY_PROVIDER ?? 'mock') === 'mock', print };
}

async function leadViews(db: D1Database, site: Site, leads: LeadRow[]): Promise<LeadView[]> {
  const ids = leads.map((l) => l.id);
  const [status, pages, scores] = await Promise.all([
    deliveryStatusForLeads(db, ids),
    pathsForLeads(db, site.id, ids),
    latestScoresForLeads(db, ids),
  ]);
  return leads.map((lead) => {
    const score = scores.get(lead.id);
    return { lead, pages: pages.get(lead.id) ?? [], delivery: status.get(lead.id) ?? null, hail: score ? hailFactsFromScore(score) : undefined };
  });
}

appRoutes.get('/app', async (c) => {
  const key = c.req.query('key') ?? '';
  if (!key) return c.html(loginPage(APP_NAME)); // the footer's "Log in" link lands here
  const ctx = await auth(c.env, c.req.url, key, c.req.query('site'));
  if (!ctx) return c.html(deniedPage(APP_NAME), 404);
  const [st, leads] = await Promise.all([siteStats(c.env.DB, ctx.site.id, ctx.account.id), listLeadsForSite(c.env.DB, ctx.site.id, 100)]);
  const sort = c.req.query('sort') === 'hail' ? 'hail' : 'newest';
  return c.html(dashboardPage(ctx, st, sortLeads(await leadViews(c.env.DB, ctx.site, leads), sort), sort));
});

/** Leads per feed page. */
const FEED_PAGE = 200;

/**
 * The feed a calling agent polls. Always one site: an admin must pass ?site=, so the
 * founder's agent can never pull customer homeowners by accident. Each poll gets the oldest
 * page after `since` (listed newest first); when `has_more` is true, poll again with
 * `since=next_since`, so a busy hour never skips a lead.
 */
appRoutes.get('/app/leads.json', async (c) => {
  const key = c.req.query('key') ?? '';
  const ctx = await auth(c.env, c.req.url, key, c.req.query('site'));
  if (!ctx) return isAdminKey(c.env, key) ? c.json({ error: 'unknown site' }, 404) : c.json({ error: 'bad key' }, 401);
  if (ctx.admin && !c.req.query('site')) return c.json({ error: 'Pass ?site=<site id>. The feed is always one site.' }, 400);
  const since = Math.max(0, Number(c.req.query('since') ?? 0) || 0);
  const rows = await listLeadsAfter(c.env.DB, ctx.site.id, since, FEED_PAGE + 1);
  const hasMore = rows.length > FEED_PAGE;
  let page = rows.slice(0, FEED_PAGE);
  // `since` is exclusive, so a page never ends partway through leads that share one timestamp.
  const edge = rows[FEED_PAGE]?.created_at;
  if (edge !== undefined && page.some((l) => l.created_at < edge)) page = page.filter((l) => l.created_at < edge);
  const leads = page.reverse();
  const views = await leadViews(c.env.DB, ctx.site, leads);
  const now = Date.now();
  return c.json({
    site: { id: ctx.site.id, name: ctx.site.name },
    now,
    next_since: leads[0]?.created_at ?? since,
    has_more: hasMore,
    mock: ctx.mock,
    leads: views.map((v) => ({ ...toLeadPayload(v.lead), pages: v.pages, status: v.delivery?.status ?? 'pending', seen_at: v.lead.created_at, hail: hailJson(v.hail, now) })),
  });
});

appRoutes.get('/app/install', async (c) => {
  const ctx = await auth(c.env, c.req.url, c.req.query('key') ?? '', c.req.query('site'));
  if (!ctx) return c.html(deniedPage(APP_NAME), 404);
  return c.html(installPage(ctx, await lastVisitAt(c.env.DB, ctx.site.id)));
});

appRoutes.get('/app/delivery', async (c) => {
  const ctx = await auth(c.env, c.req.url, c.req.query('key') ?? '', c.req.query('site'));
  if (!ctx) return c.html(deniedPage(APP_NAME), 404);
  return c.html(deliveryPage(ctx));
});

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const KINDS = new Set<WebhookKind>(['json', 'slack', 'ghl']);
/** Test leads per site per hour. Enough to fix a setup; not enough to use us to email someone over and over. */
const TEST_LEADS_PER_HOUR = 5;

appRoutes.post('/app/delivery', async (c) => {
  const ctx = await auth(c.env, c.req.url, c.req.query('key') ?? '', c.req.query('site'));
  if (!ctx) return c.html(deniedPage(APP_NAME), 404);
  const f = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const leadEmail = String(f.lead_email ?? '').trim().toLowerCase() || null;
  const webhookUrl = String(f.webhook_url ?? '').trim() || null;
  const kindRaw = String(f.webhook_kind ?? 'json').toLowerCase() as WebhookKind;
  const webhookKind: WebhookKind = KINDS.has(kindRaw) ? kindRaw : 'json';
  if (leadEmail && !EMAIL.test(leadEmail)) return c.html(deliveryPage(ctx, { ok: false, msg: 'That email address does not look right.' }), 400);
  if (webhookUrl && !isAllowedWebhookUrl(webhookUrl, new URL(c.req.url).hostname)) return c.html(deliveryPage(ctx, { ok: false, msg: 'The webhook URL must start with https:// and point outside Yardsign.' }), 400);
  await updateSiteDelivery(c.env.DB, ctx.site.id, { leadEmail, webhookUrl, webhookKind });
  const site = (await getSiteById(c.env.DB, ctx.site.id)) ?? ctx.site;
  const next = { ...ctx, site };
  if (f.action !== 'test') return c.html(deliveryPage(next, { ok: true, msg: 'Saved.' }));

  // A test lead goes through the real channels but is never stored.
  const testLead: LeadRow = {
    id: 'lead_test',
    site_id: site.id,
    visitor_id: 'test_manual',
    identity_request_id: 'req_test',
    first_name: 'Test',
    last_name: 'Homeowner',
    address_line1: '123 Example St',
    address_line2: null,
    city: 'Denton',
    state: 'TX',
    zip: '76201',
    phone: '(972) 555-0100',
    email: 'test.homeowner@example.com',
    confidence: 0.9,
    lat: null,
    lng: null,
    linkedin_url: null,
    email_hash: null,
    extra: JSON.stringify({ test: true }),
    created_at: Date.now(),
  };
  const channels = getDeliveryChannels(c.env, c.env.DB, site, { city: 'Denton', region: 'TX' }, 'mock', c.get('log')).filter((ch) => ch.name !== 'log');
  if (channels.length === 0) return c.html(deliveryPage(next, { ok: false, msg: 'Saved. Add an email or a webhook first, then send a test.' }));
  const rl = await checkRateLimit(c.env.DB, `${HOURLY_KEY_PREFIX}test-lead:${site.id}`, TEST_LEADS_PER_HOUR, Date.now(), HOUR_MS);
  if (!rl.allowed) return c.html(deliveryPage(next, { ok: false, msg: `Saved. You can send ${TEST_LEADS_PER_HOUR} test leads an hour. Please try again later.` }), 429);
  const results: string[] = [];
  for (const ch of channels) {
    try {
      await ch.send(testLead, toLeadPayload(testLead), c.get('log'));
      results.push(`${ch.name}: sent`);
    } catch (err) {
      results.push(`${ch.name}: failed (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  const allOk = results.every((r) => r.endsWith(': sent'));
  return c.html(deliveryPage(next, { ok: allOk, msg: `Saved. Test lead: ${results.join('; ')}.` }));
});

/** Admin-only helper: open any site's dashboard by site key. */
appRoutes.get('/api/admin/sites/:siteKey/dashboard', async (c) => {
  const header = c.req.header('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!c.env.ADMIN_TOKEN || c.env.ADMIN_TOKEN.length < 8 || !safeEqual(presented, c.env.ADMIN_TOKEN)) return c.json({ error: 'unauthorized' }, 401);
  const siteKey = c.req.param('siteKey');
  if (!isValidSiteKey(siteKey)) return c.json({ error: 'bad site key' }, 400);
  const all = await listSites(c.env.DB);
  const site = all.find((s) => s.siteKey === siteKey);
  if (!site) return c.json({ error: 'unknown site' }, 404);
  return c.json({ dashboard_url: `${publicBaseUrl(c.env, c.req.url)}/app?key=${site.dashKey ?? ''}` });
});
