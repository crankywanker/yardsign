/**
 * The bearer-token JSON admin API, under /api/admin/... Bearer ADMIN_TOKEN only.
 * It lives outside /admin on purpose: Cloudflare Access fronts /admin (the HTML operator page)
 * and would send these machine calls to its login page.
 */
import { Hono } from 'hono';
import { getSiteByKey, insertSite, listRecentVisitsWithLeads, listSites, parseJson, setSiteDelivrPixel, updateSiteDelivery, type WebhookKind } from '@yardsign/db';
import type { Env } from '../env';
import { HAIL_SYNC_LOOKBACK_MS, runHailSync } from '../hail-sync';
import { toLeadPayload } from '../delivery';
import { ensureDelivrPixel } from '../delivr-pixel';
import { leadHtml, leadSubject, leadText, type LeadCardInput } from '../email/lead-card';
import { getEmailSender } from '../email/sender';
import { safeEqual } from '../hash';
import type { Logger } from '../log';
import { pollUnresolvedVisits } from '../resolution';
import { isValidSiteKey } from '../validate';
import { isAllowedWebhookUrl } from '../webhook';

type Vars = { log: Logger; requestId: string };
export const adminRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

adminRoutes.use('/api/admin/*', async (c, next) => {
  const token = c.env.ADMIN_TOKEN;
  const header = c.req.header('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token || token.length < 8 || !presented || !safeEqual(presented, token)) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
});

adminRoutes.get('/api/admin/visits', async (c) => {
  const siteKey = c.req.query('siteKey') ?? '';
  if (!isValidSiteKey(siteKey)) return c.json({ error: 'siteKey required' }, 400);
  const site = await getSiteByKey(c.env.DB, siteKey);
  if (!site) return c.json({ error: 'unknown site' }, 404);
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? '25') || 25));
  const rows = await listRecentVisitsWithLeads(c.env.DB, site.id, limit);
  const visits = rows.map((v) => ({
    ...v,
    device: parseJson(v.device, null),
    screen: parseJson(v.screen, null),
    score: v.score ? { ...v.score, components: parseJson(v.score.components, {}) } : null,
    lead: v.lead ? { ...v.lead, extra: parseJson(v.lead.extra, {}) } : null,
  }));
  return c.json({ site: { id: site.id, key: site.siteKey, name: site.name }, count: visits.length, visits });
});

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOSTNAME = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$|^localhost$/;

function randomSiteKey(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

/** Sites with their delivery setting. The dashboard replaces this later. */
adminRoutes.get('/api/admin/sites', async (c) => {
  const sites = await listSites(c.env.DB);
  return c.json({ count: sites.length, sites });
});

/**
 * Add a site. Body: { name, allowed_domains: ["example.com"], lead_email?, site_key?, account_id? }.
 * Until Stripe creates accounts, new sites hang off the founder's account.
 */
adminRoutes.post('/api/admin/sites', async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: 'body must be JSON' }, 400);
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';
  const domains = Array.isArray(body.allowed_domains) ? body.allowed_domains.map((d) => String(d).trim().toLowerCase()) : [];
  const leadEmail = typeof body.lead_email === 'string' && body.lead_email.trim() ? body.lead_email.trim().toLowerCase() : null;
  const webhook = parseWebhook(body, new URL(c.req.url).hostname);
  if ('error' in webhook) return c.json({ error: webhook.error }, 400);
  const siteKey = typeof body.site_key === 'string' && body.site_key ? body.site_key : randomSiteKey();
  const accountId = typeof body.account_id === 'string' && body.account_id ? body.account_id : 'acct_yardsign';
  if (!name) return c.json({ error: 'name required' }, 400);
  if (domains.length === 0 || domains.some((d) => !HOSTNAME.test(d))) return c.json({ error: 'allowed_domains must be one or more hostnames' }, 400);
  if (leadEmail && !EMAIL.test(leadEmail)) return c.json({ error: 'lead_email is not an email address' }, 400);
  if (!isValidSiteKey(siteKey)) return c.json({ error: 'site_key must be 4-64 letters, digits, - or _' }, 400);
  if (await getSiteByKey(c.env.DB, siteKey)) return c.json({ error: 'site_key already exists' }, 409);
  const created = await insertSite(c.env.DB, { accountId, siteKey, name, allowedDomains: domains, leadEmail, ...webhook });
  c.get('log').info('admin: site created', { site_id: created.id, site_key: created.siteKey, domains });
  const pixelId = await ensureDelivrPixel(c.env, created, c.get('log'));
  const site = pixelId ? { ...created, delivrPixelId: pixelId } : created;
  const base = (c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin).replace(/\/+$/, '');
  return c.json({ site, install_tag: `<script async src="${base}/p/${site.siteKey}.js"></script>`, dashboard_url: `${base}/app?key=${site.dashKey ?? ''}` }, 201);
});

const WEBHOOK_KINDS = new Set<WebhookKind>(['json', 'slack', 'ghl']);

function parseWebhook(body: Record<string, unknown>, ownHost: string): { webhookUrl: string | null; webhookKind: WebhookKind | null } | { error: string } {
  const url = typeof body.webhook_url === 'string' && body.webhook_url.trim() ? body.webhook_url.trim() : null;
  if (!url) return { webhookUrl: null, webhookKind: null };
  if (!isAllowedWebhookUrl(url, ownHost)) return { error: 'webhook_url must be an https URL to an outside host' };
  const kind = typeof body.webhook_kind === 'string' ? (body.webhook_kind.toLowerCase() as WebhookKind) : 'json';
  if (!WEBHOOK_KINDS.has(kind)) return { error: 'webhook_kind must be json, slack or ghl' };
  return { webhookUrl: url, webhookKind: kind };
}

/**
 * Set or clear where a site's leads go. Body: { lead_email?: string | null, webhook_url?: string | null, webhook_kind?: "json" | "slack" | "ghl" }.
 * Fields left out are cleared, so send the full setting.
 */
adminRoutes.put('/api/admin/sites/:siteKey/delivery', async (c) => {
  const siteKey = c.req.param('siteKey');
  if (!isValidSiteKey(siteKey)) return c.json({ error: 'bad site key' }, 400);
  const site = await getSiteByKey(c.env.DB, siteKey);
  if (!site) return c.json({ error: 'unknown site' }, 404);
  const body = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const leadEmail = typeof body.lead_email === 'string' && body.lead_email.trim() ? body.lead_email.trim().toLowerCase() : null;
  if (leadEmail && !EMAIL.test(leadEmail)) return c.json({ error: 'lead_email is not an email address' }, 400);
  const webhook = parseWebhook(body, new URL(c.req.url).hostname);
  if ('error' in webhook) return c.json({ error: webhook.error }, 400);
  await updateSiteDelivery(c.env.DB, site.id, { leadEmail, ...webhook });
  return c.json({ site_key: siteKey, lead_email: leadEmail, webhook_url: webhook.webhookUrl, webhook_kind: webhook.webhookKind });
});

const DELIVR_PIXEL = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Set or clear the site's Delivr pixel id. Body: { pixel_id: "..." } or { pixel_id: null }.
 * Make the pixel with the "Delivr setup" workflow in GitHub, then paste its id here. With an id,
 * the served pixel loads Delivr's script and the resolution step asks Delivr; without one the
 * site stays on the mock provider.
 */
adminRoutes.put('/api/admin/sites/:siteKey/delivr', async (c) => {
  const siteKey = c.req.param('siteKey');
  if (!isValidSiteKey(siteKey)) return c.json({ error: 'bad site key' }, 400);
  const site = await getSiteByKey(c.env.DB, siteKey);
  if (!site) return c.json({ error: 'unknown site' }, 404);
  const body = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const pixelId = typeof body.pixel_id === 'string' && body.pixel_id.trim() ? body.pixel_id.trim() : null;
  if (pixelId && !DELIVR_PIXEL.test(pixelId)) return c.json({ error: 'pixel_id must be 8-64 letters, digits or dashes' }, 400);
  await setSiteDelivrPixel(c.env.DB, site.id, pixelId);
  c.get('log').info('admin: delivr pixel set', { site_id: site.id, site_key: siteKey, pixel_id: pixelId });
  return c.json({ site_key: siteKey, delivr_pixel_id: pixelId });
});

/** Run the poll step now instead of waiting for the cron. Handy in local dev. */
adminRoutes.post('/api/admin/resolve', async (c) => {
  const n = await pollUnresolvedVisits(c.env, c.get('log'));
  return c.json({ processed: n });
});

/** Load (or refresh) hail events from the configured source. `?days=N` (1 to 180) narrows the pull; default is the full six months. */
adminRoutes.post('/api/admin/hail/sync', async (c) => {
  const days = Number.parseInt(c.req.query('days') ?? '', 10);
  const lookback = days >= 1 && days <= 180 ? days * 24 * 60 * 60 * 1000 : HAIL_SYNC_LOOKBACK_MS;
  return c.json(await runHailSync(c.env, c.get('log'), lookback));
});

/**
 * Send a sample lead card to one address, to prove the email provider and DNS work.
 * Body: { to: "you@example.com" }. Nothing is written to the database. The card is marked TEST.
 * `.github/workflows/test-card.yml` calls this with the ADMIN_TOKEN secret, so nobody has to paste the token.
 */
adminRoutes.post('/api/admin/email/test', async (c) => {
  const body = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const to = typeof body.to === 'string' ? body.to.trim().toLowerCase() : '';
  if (!to || !EMAIL.test(to)) return c.json({ error: 'to must be an email address' }, 400);
  let email: ReturnType<typeof getEmailSender>;
  try {
    email = getEmailSender(c.env);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
  if (!email) return c.json({ error: 'EMAIL_PROVIDER is not set; leads go to the log channel' }, 409);
  const now = Date.now();
  const input: LeadCardInput = {
    payload: toLeadPayload({
      id: `lead_test_${now}`, site_id: 'site_test', visitor_id: '00000000-0000-4000-8000-000000000000', identity_request_id: 'req_test',
      first_name: 'Maria', last_name: 'Garcia', address_line1: '412 Example Ln', address_line2: null,
      city: 'Plano', state: 'TX', zip: '75024', phone: '(972) 555-0142', email: 'maria.garcia@example.com',
      confidence: 0.84, lat: null, lng: null, linkedin_url: null, email_hash: null, extra: '{"mock":true,"test_card":true}', created_at: now,
    }),
    siteName: 'Test Roofing',
    pages: ['/roof-repair', '/'],
    connection: { city: 'Plano', region: 'TX' },
    mock: true,
    // Sample hail so the test card shows the hail box. Made up, like the person.
    hail: { kind: 'found', inches: 1.75, miles: 1.2, at: now - 9 * 24 * 60 * 60 * 1000, place: '2 mi NNE of Plano', others: 2, score: 74, fromHome: true, source: 'noaa' },
    now,
    dashboardUrl: `${(c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin).replace(/\/+$/, '')}/app`,
  };
  try {
    const res = await email.sender.send({ to, from: email.from, subject: leadSubject(input), html: leadHtml(input), text: leadText(input) });
    c.get('log').info('admin: test card sent', { to, provider: email.sender.name, message_id: res.id });
    return c.json({ sent: true, to, from: email.from, provider: email.sender.name, message_id: res.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    c.get('log').error('admin: test card failed', { to, provider: email.sender.name, error: message });
    return c.json({ sent: false, to, from: email.from, provider: email.sender.name, error: message }, 502);
  }
});
