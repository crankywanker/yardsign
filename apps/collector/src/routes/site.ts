/**
 * The public site: landing page with the live demo card, stylesheet, demo refresh,
 * legal pages and opt-out. The founder's own pages carry the pixel (the flywheel).
 */
import { Hono } from 'hono';
import { getSiteByKey, hashEmail, optOut } from '@yardsign/db';
import { cleanDomain, createCheckout, isPlanId, siteForSession, stripeConfigured, handleStripeWebhook } from '../billing';
import { demoView, resolveVerdict } from '../demo';
import { isBot } from '../bots';
import { allowedStates } from '../policy';
import type { Env } from '../env';
import { hashIp } from '../hash';
import type { Logger } from '../log';
import { landingPage } from '../pages/landing';
import { CSS } from '../pages/layout';
import { messagePage, optoutPage, privacyPage, termsPage } from '../pages/legal';
import { WELCOME_REFRESH_S, welcomePage } from '../pages/welcome';
import { APP_NAME } from '../plans';
import { sendOptOutRecalls } from '../optout-notice';
import { checkRateLimit } from '../rate-limit';
import { readRequestContext } from '../request-context';

type Vars = { log: Logger; requestId: string };
export const siteRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

/** The site key for the founder's own domain. Seeded by migration 0003. */
export const HOME_SITE_KEY = 'TRYYARDSIGN';

export function publicBaseUrl(env: Env, requestUrl: string): string {
  const base = (env.PUBLIC_BASE_URL ?? '').trim().replace(/\/+$/, '');
  return base || new URL(requestUrl).origin;
}

/** The pixel tag for our own pages, or empty when the site row is missing or off, or the database is down. */
async function homePixelTag(env: Env): Promise<string> {
  try {
    const site = await getSiteByKey(env.DB, HOME_SITE_KEY);
    return site && site.active ? `<script async src="/p/${HOME_SITE_KEY}.js"></script>` : '';
  } catch {
    return ''; // the landing page still works without the database
  }
}

function demoFor(env: Env, req: Request) {
  const ctx = readRequestContext(req);
  const view = demoView(ctx, ctx.timezone);
  const bot = isBot({ userAgent: ctx.userAgent, botScore: ctx.botScore, verifiedBot: ctx.verifiedBot });
  const verdict = resolveVerdict({ local: ctx.local, gpc: ctx.gpc, country: ctx.country, region: ctx.region, asnClass: view.asnClass, bot }, allowedStates(env));
  return { ctx, view, verdict };
}

siteRoutes.get('/', async (c) => {
  const { view, verdict } = demoFor(c.env, c.req.raw);
  c.header('Cache-Control', 'no-store'); // the demo card is per visitor
  return c.html(landingPage(APP_NAME, view, verdict, await homePixelTag(c.env)));
});

siteRoutes.get('/style.css', (c) => {
  c.header('Content-Type', 'text/css; charset=utf-8');
  c.header('Cache-Control', 'public, max-age=3600');
  return c.body(CSS);
});

siteRoutes.get('/demo.json', async (c) => {
  const { ctx, view, verdict } = demoFor(c.env, c.req.raw);
  if (c.env.IP_SALT) {
    // 30 refreshes a minute per IP is plenty for a human.
    const rl = await checkRateLimit(c.env.DB, `demo:${await hashIp(ctx.ip, c.env.IP_SALT)}`, 30);
    if (!rl.allowed) return c.json({ error: 'Slow down a little.' }, 429);
  }
  c.header('Cache-Control', 'no-store');
  return c.json({ view, verdict: { wouldTry: verdict.wouldTry, why: verdict.why } });
});

siteRoutes.get('/privacy', (c) => c.html(privacyPage(APP_NAME)));
siteRoutes.get('/terms', (c) => c.html(termsPage(APP_NAME, publicBaseUrl(c.env, c.req.url))));
siteRoutes.get('/optout', (c) => c.html(optoutPage(APP_NAME, 'form')));

siteRoutes.post('/optout', async (c) => {
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const email = String(form.email ?? '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.html(optoutPage(APP_NAME, 'error', 'Please enter a valid email address.'), 400);
  const emailHash = await hashEmail(email);
  // One batch: record the opt-out, queue a recall for every business that could see a lead, delete the leads.
  const { deleted, recallIds } = await optOut(c.env.DB, emailHash);
  c.get('log').info('optout recorded', { leads_deleted: deleted, leads_to_recall: recallIds.length }); // never the email or its hash
  // Tell each business now; anything that fails stays queued and the cron tries again.
  const notice = sendOptOutRecalls(c.env, APP_NAME, c.get('log'), { ids: recallIds });
  try {
    c.executionCtx.waitUntil(notice);
  } catch {
    await notice;
  }
  return c.html(optoutPage(APP_NAME, 'done'));
});

// ---------- billing ----------

/** Per-IP limit for the billing pages, so a script cannot hammer Stripe through us. Off without IP_SALT (local dev). */
async function overIpLimit(env: Env, req: Request, name: string, perMinute: number): Promise<boolean> {
  if (!env.IP_SALT) return false;
  const rl = await checkRateLimit(env.DB, `${name}:${await hashIp(readRequestContext(req).ip, env.IP_SALT)}`, perMinute);
  return !rl.allowed;
}

siteRoutes.post('/checkout', async (c) => {
  const back = (msg: string, status: 400 | 429 | 503 = 400) => c.html(messagePage(APP_NAME, 'Checkout', msg, 'bad'), status);
  if (await overIpLimit(c.env, c.req.raw, 'checkout', 10)) return back('Too many tries. Please wait a minute and try again.', 429);
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const plan = isPlanId(form.plan) ? form.plan : 'starter';
  const email = String(form.email ?? '').trim().toLowerCase();
  const domain = cleanDomain(String(form.domain ?? ''));
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return back('Please enter a valid email address.');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return back('Please enter your website, like yourroofing.com.');
  if (!stripeConfigured(c.env)) return back('We are not taking payments yet. Email hello@tryyardsign.com and we will set you up by hand.', 503);
  try {
    return c.redirect(await createCheckout(c.env, plan, email, domain, publicBaseUrl(c.env, c.req.url)), 303);
  } catch (err) {
    c.get('log').error('checkout failed', { error: err instanceof Error ? err.message : String(err) });
    return back('We could not start checkout. Please try again in a minute.', 503);
  }
});

siteRoutes.post('/stripe/webhook', async (c) => {
  const outcome = await handleStripeWebhook(c.env, await c.req.text(), c.req.header('stripe-signature') ?? '');
  if (!outcome.ok) {
    c.get('log').warn('stripe webhook rejected', { status: outcome.status, error: outcome.error });
    return c.text(outcome.error, outcome.status as 400 | 503);
  }
  c.get('log').info('stripe webhook handled', { event: outcome.handled });
  return c.text('ok');
});

/** While the payment goes through, /welcome reloads itself for about 2 minutes, then stops and says so. */
const WELCOME_MAX_REFRESHES = Math.round(120 / WELCOME_REFRESH_S);

siteRoutes.get('/welcome', async (c) => {
  const id = c.req.query('session_id') ?? '';
  const base = publicBaseUrl(c.env, c.req.url);
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return c.html(welcomePage(APP_NAME, base, null, false, 'Missing checkout session.'), 400);
  if (await overIpLimit(c.env, c.req.raw, 'welcome', 20)) return c.html(welcomePage(APP_NAME, base, null, false, 'Too many requests. Please wait a minute, then reload this page.'), 429);
  if (!stripeConfigured(c.env)) return c.html(welcomePage(APP_NAME, base, null, false, 'Payments are not set up yet.'), 503);
  try {
    const state = await siteForSession(c.env, id);
    if (state.kind === 'site') return c.html(welcomePage(APP_NAME, base, state.site, false));
    if (state.kind === 'expired') return c.html(welcomePage(APP_NAME, base, null, false, 'This checkout expired before it was paid, so you were not charged. Please start again from our pricing section.'), 410);
    const n = Math.max(0, Math.floor(Number(c.req.query('n') ?? 0)) || 0);
    const refreshUrl = n < WELCOME_MAX_REFRESHES ? `/welcome?session_id=${id}&n=${n + 1}` : null;
    return c.html(welcomePage(APP_NAME, base, null, true, undefined, refreshUrl));
  } catch (err) {
    c.get('log').error('welcome failed', { error: err instanceof Error ? err.message : String(err) });
    return c.html(welcomePage(APP_NAME, base, null, false, 'We could not find that checkout.'), 404);
  }
});
