import { Hono } from 'hono';
import { DAY_MS, clearExpiredRawIps, deleteOldVisits, scrubWithheldResponses } from '@yardsign/db';
import { retryMissingDelivrPixels } from './delivr-pixel';
import { retryFailedDeliveries } from './delivery';
import { cronLookbackMs, runHailSync } from './hail-sync';
import type { Env } from './env';
import { createLogger, errorFields, requestId, type Logger } from './log';
import { notFoundPage } from './pages/legal';
import { APP_NAME } from './plans';
import { WITHHELD_RETENTION_DAYS } from './policy';
import { pruneRateLimits } from './rate-limit';
import { sendOptOutRecalls } from './optout-notice';
import { pollUnresolvedVisits } from './resolution';
import { getScheduler } from './scheduler';
import { adminRoutes } from './routes/admin';
import { adminPageRoutes } from './routes/admin-page';
import { appRoutes } from './routes/app';
import { collectRoutes } from './routes/collect';
import { siteRoutes } from './routes/site';
import { pixelRoutes } from './routes/pixel';
import { seoRoutes } from './routes/seo';
import { isApiPath, isPrivatePath, wantsHtml } from './seo';

type Vars = { log: Logger; requestId: string };

export const app = new Hono<{ Bindings: Env; Variables: Vars }>();

app.use('*', async (c, next) => {
  const id = requestId(c.req.raw);
  const log = createLogger({ req_id: id, method: c.req.method, path: new URL(c.req.url).pathname });
  c.set('requestId', id);
  c.set('log', log);
  const started = Date.now();
  await next();
  log.info('request', { status: c.res.status, ms: Date.now() - started });
});

/**
 * Private routes tell search engines to stay out, whatever the handler returned.
 * robots.txt alone does not keep a page out of Google; this header does.
 */
app.use('*', async (c, next) => {
  await next();
  if (isPrivatePath(new URL(c.req.url).pathname)) c.header('X-Robots-Tag', 'noindex, nofollow');
});

app.onError((err, c) => {
  c.get('log')?.error('unhandled error', errorFields(err));
  return c.json({ error: 'internal error', request_id: c.get('requestId') }, 500);
});

app.get('/health', (c) => c.json({ ok: true, sha: c.env.BUILD_SHA ?? 'dev', provider: c.env.IDENTITY_PROVIDER ?? 'mock', resolution: getScheduler(c.env).mode }));

app.route('/', seoRoutes);
app.route('/', siteRoutes);
app.route('/', pixelRoutes);
app.route('/', collectRoutes);
app.route('/', appRoutes);
app.route('/', adminPageRoutes); // HTML operator page at /admin, behind Cloudflare Access
app.route('/', adminRoutes); // bearer-token JSON API at /api/admin/..., outside Access on purpose

/** A browser or crawler asking for a page gets a real 404 page. API and collector paths stay JSON. */
app.notFound((c) => {
  c.header('X-Robots-Tag', 'noindex, nofollow');
  const path = new URL(c.req.url).pathname;
  if (wantsHtml(c.req.header('accept')) && !isApiPath(path)) return c.html(notFoundPage(APP_NAME), 404);
  return c.json({ error: 'not found' }, 404);
});

export const CRON_POLL = '*/5 * * * *';
/** Hourly: fresh hail should reach the card within the hour. Once a day (03:23 UTC) it re-reads the full six months. */
export const CRON_HAIL = '23 * * * *';

/** Queue mode: the cron still sweeps visits older than this that the queue never finished (dropped after its retries, say). */
export const QUEUE_SWEEP_AGE_MS = 30 * 60 * 1000;

export async function runScheduled(env: Env, cron: string, log: Logger, now = Date.now()): Promise<void> {
  if (cron === CRON_HAIL) {
    // A paying site whose Delivr pixel failed at checkout: try again, once an hour.
    await step(log, 'delivr_pixels', () => retryMissingDelivrPixels(env, log));
    await runHailSync(env, log, await cronLookbackMs(env, now), now);
    return;
  }
  // Every step on its own: one failure never stops the rest. The cleanups and the recalls are a
  // few queries each and go first, so the 72-hour raw IP promise never waits on a long poll (one
  // run has a query budget, and the poll can use most of it).
  const cleared = await step(log, 'clear_raw_ips', () => clearExpiredRawIps(env.DB));
  const pruned = await step(log, 'prune_rate_limits', () => pruneRateLimits(env.DB));
  const expired = await step(log, 'delete_old_visits', () => deleteOldVisits(env.DB)); // 13 months, as the privacy page says
  const scrubbed = await step(log, 'scrub_withheld', () => scrubWithheldResponses(env.DB, WITHHELD_RETENTION_DAYS * DAY_MS)); // withheld matches: 30 days, then gone
  // Opt-out recalls that did not go out the first time. Never throws.
  const recalls = await sendOptOutRecalls(env, APP_NAME, log, { now });
  // Lead cards and webhooks that failed (a short Resend or webhook outage): try again, with back-off. Logs its own counts.
  await step(log, 'retry_deliveries', () => retryFailedDeliveries(env, log, now));
  const sweep = getScheduler(env).mode === 'queue' ? { createdBefore: now - QUEUE_SWEEP_AGE_MS } : {};
  const processed = await step(log, 'poll', () => pollUnresolvedVisits(env, log, sweep));
  log.info('cron: done', { raw_ips_cleared: cleared, rate_rows_pruned: pruned, old_visits_deleted: expired, withheld_scrubbed: scrubbed, recalls_sent: recalls, visits_processed: processed });
}

/** One cron step. A failure is logged and gives null, and the next step still runs. */
async function step<T>(log: Logger, name: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    log.error(`cron: ${name} failed`, errorFields(err));
    return null;
  }
}
