import { Hono } from 'hono';
import { getLiveSiteByKey, insertVisit, setTimeOnPage, upsertVisitor, type NewVisit, type Site } from '@yardsign/db';
import { scoreAndStore } from '@yardsign/scoring';
import { isBot } from '../bots';
import { allowedOrigin, collectCors, corsHeaders } from '../cors';
import { classifyAsn } from '../demo';
import { parseDevice } from '../device';
import { intVar, type Env } from '../env';
import { isGeoBlocked } from '../geo-block';
import { hashIp } from '../hash';
import { errorFields, type Logger } from '../log';
import { checkRateLimit, ipv6Prefix64 } from '../rate-limit';
import { readRequestContext } from '../request-context';
import { getScheduler } from '../scheduler';
import { hailSourceName } from '../hail-sync';
import { clampClock, cleanPageUrl, cleanReferrer, isValidSiteKey, MAX_PAYLOAD_BYTES, parseBody, validatePayload } from '../validate';

type Vars = { log: Logger; requestId: string };
export const collectRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

/** Everything returns an empty body, so a bad beacon never learns why it was dropped. */
function empty(status: 204 | 403 | 413 | 429 | 500, headers?: Record<string, string>): Response {
  return new Response(null, { status, headers });
}

async function siteFromKey(env: Env, key: unknown): Promise<Site | null> {
  return isValidSiteKey(key) ? getLiveSiteByKey(env.DB, key) : null;
}

/** The body as text, or null once it passes `max` bytes. Stops reading there, so a body with no Content-Length is never read whole. */
async function readCapped(req: Request, max: number): Promise<string | null> {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Preflight. The pixel avoids triggering one, but a customer's own code might not. Pass ?k=SITEKEY. */
collectRoutes.options('/collect', async (c) => {
  const site = await siteFromKey(c.env, c.req.query('k'));
  const origin = allowedOrigin(c.req.header('origin') ?? null, site?.allowedDomains ?? []);
  return origin ? empty(204, corsHeaders(origin)) : empty(403);
});

collectRoutes.post('/collect', async (c) => {
  const log = c.get('log');
  const env = c.env;

  const declared = Number(c.req.header('content-length') ?? '0');
  if (declared > MAX_PAYLOAD_BYTES) return empty(413);
  const text = await readCapped(c.req.raw, MAX_PAYLOAD_BYTES);
  if (text === null) return empty(413);

  const validated = validatePayload(parseBody(text));
  if (!validated.ok) {
    log.info('collect: rejected payload', { reason: validated.error });
    return empty(204);
  }
  const payload = validated.payload;

  // Unknown, turned off, or the account's subscription ended: drop it.
  const site = await getLiveSiteByKey(env.DB, payload.k);
  if (!site) {
    log.info('collect: unknown or inactive site', { site_key: payload.k });
    return empty(204);
  }

  // CORS: the Origin header must match a registered domain. fetch and sendBeacon both send it cross-origin;
  // an Origin of "null" (strict Referrer-Policy) falls back to the page URL (src/cors.ts).
  const cors = collectCors(c.req.header('origin') ?? null, payload.e === 'view' ? payload.u : '', site.allowedDomains);
  if (!cors) {
    log.info('collect: origin not allowed', { site_id: site.id, origin: c.req.header('origin') ?? null });
    return empty(403);
  }

  const ctx = readRequestContext(c.req.raw);
  if (isGeoBlocked(ctx.country)) return empty(204, cors);
  if (isBot({ userAgent: ctx.userAgent, botScore: ctx.botScore, verifiedBot: ctx.verifiedBot })) {
    log.info('collect: dropped bot', { site_id: site.id, bot_score: ctx.botScore });
    return empty(204, cors);
  }

  if (!env.IP_SALT) {
    log.error('collect: IP_SALT is not set');
    return empty(500, cors);
  }
  const ipHash = await hashIp(ctx.ip, env.IP_SALT);
  // IPv6 is limited per /64 (one home or phone network), so rotating addresses inside it does not reset the count.
  const prefix = ipv6Prefix64(ctx.ip);
  const ipKey = prefix ? await hashIp(prefix, env.IP_SALT) : ipHash;

  // The IP first, and only an allowed request counts toward the site. Otherwise one sender
  // blocked by its own limit could still use up the site's and shut out every real visitor.
  const siteLimit = intVar(env.RATE_LIMIT_SITE_PER_MIN, 600);
  const ipLimit = intVar(env.RATE_LIMIT_IP_PER_MIN, 60);
  const byIp = await checkRateLimit(env.DB, `ip:${ipKey}`, ipLimit);
  const bySite = byIp.allowed ? await checkRateLimit(env.DB, `site:${site.id}`, siteLimit) : null;
  if (!bySite?.allowed) {
    log.warn('collect: rate limited', { site_id: site.id, by_site: bySite ? Math.round(bySite.estimate) : null, by_ip: Math.round(byIp.estimate) });
    return empty(429, { ...cors, 'Retry-After': '60' });
  }

  const now = Date.now();

  if (payload.e === 'unload') {
    const changed = await setTimeOnPage(env.DB, site.id, payload.vid, payload.id, payload.top);
    log.info('collect: time on page', { site_id: site.id, visit_id: payload.id, time_on_page_ms: payload.top, matched: changed });
    return empty(204, cors);
  }

  let path = '/';
  try {
    path = new URL(payload.u).pathname;
  } catch {
    /* validated already */
  }

  const visit: NewVisit = {
    id: payload.id,
    site_id: site.id,
    visitor_id: payload.vid,
    session_id: payload.sid,
    url: cleanPageUrl(payload.u),
    path,
    referrer: cleanReferrer(payload.r) || null,
    title: payload.t || null,
    ip_hash: ipHash,
    ip_raw: ctx.ip,
    country: ctx.country,
    region: ctx.region,
    city: ctx.city,
    postal: ctx.postal,
    asn: ctx.asn,
    colo: ctx.colo,
    lat: ctx.lat,
    lng: ctx.lng,
    user_agent: ctx.userAgent,
    device: JSON.stringify(parseDevice(ctx.userAgent)),
    screen: JSON.stringify(payload.s),
    timezone: payload.tz || null,
    language: payload.l || null,
    bot_score: ctx.botScore,
    occurred_at: clampClock(payload.ts, now),
    created_at: now,
    gpc: ctx.gpc ? 1 : 0,
    asn_org: ctx.asOrganization,
    asn_class: classifyAsn(ctx.asn, ctx.asOrganization),
  };

  try {
    await upsertVisitor(env.DB, site.id, payload.vid, now);
    await insertVisit(env.DB, visit);
  } catch (err) {
    // A replayed beacon with the same visit id lands here. Not worth a retry.
    log.warn('collect: insert failed', { site_id: site.id, visit_id: payload.id, ...errorFields(err) });
    return empty(204, cors);
  }
  log.info('collect: visit stored', { site_id: site.id, visit_id: visit.id, visitor_id: visit.visitor_id, page_path: path, country: ctx.country, postal: ctx.postal });

  // After the response: hand off resolution (a no-op in poll mode) and take the ZIP-level hail score.
  const scheduler = getScheduler(env);
  c.executionCtx.waitUntil(
    (async () => {
      try {
        await scheduler.enqueue(visit.id);
      } catch (err) {
        log.error('collect: enqueue failed', { visit_id: visit.id, mode: scheduler.mode, ...errorFields(err) });
      }
      try {
        const { result } = await scoreAndStore(env.DB, { ...visit, time_on_page_ms: null, resolve_attempted_at: null, skip_reason: null }, null, now, hailSourceName(env));
        log.info('scoring: zip-level', { visit_id: visit.id, score: result.score });
      } catch (err) {
        log.error('scoring: zip-level failed', { visit_id: visit.id, ...errorFields(err) });
      }
    })(),
  );

  return empty(204, cors);
});
