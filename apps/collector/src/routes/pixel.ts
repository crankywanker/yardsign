import { Hono } from 'hono';
import { getLiveSiteByKey, touchPixelSeen } from '@yardsign/db';
import { PIXEL_BUILD_HASH, renderPixel } from '@yardsign/pixel';
import { allowedOrigin } from '../cors';
import type { Env } from '../env';
import { classifyAsn } from '../demo';
import { allowedStates, requestGate } from '../policy';
import { readRequestContext } from '../request-context';
import { isValidSiteKey } from '../validate';

/** Never public: the file carries a per-visitor gate answer. Short, so a changed answer lands soon. */
export const PIXEL_CACHE_CONTROL = 'private, max-age=300';

export const pixelRoutes = new Hono<{ Bindings: Env }>();

/** The collect URL the pixel should post to: PUBLIC_BASE_URL in prod, the request origin in dev. */
export function collectUrl(env: Env, requestUrl: string): string {
  const base = (env.PUBLIC_BASE_URL ?? '').trim().replace(/\/+$/, '');
  return `${base || new URL(requestUrl).origin}/collect`;
}

pixelRoutes.get('/p/:file', async (c) => {
  const file = c.req.param('file');
  const siteKey = file.endsWith('.js') ? file.slice(0, -3) : '';
  c.header('Content-Type', 'application/javascript; charset=utf-8');
  if (!isValidSiteKey(siteKey)) {
    c.header('Cache-Control', 'public, max-age=300');
    return c.body('/* yardsign: unknown site */', 404);
  }
  // Unknown, turned off, or the account's subscription ended: no pixel, so no partner script either.
  const site = await getLiveSiteByKey(c.env.DB, siteKey);
  if (!site) {
    c.header('Cache-Control', 'public, max-age=300');
    return c.body('/* yardsign: unknown site */', 404);
  }
  // Remember that the tag is on a page (for /admin). Off the request path when we have a context.
  const seen = touchPixelSeen(c.env.DB, site.id).catch(() => false);
  try {
    c.executionCtx.waitUntil(seen);
  } catch {
    await seen;
  }
  // Gate 1 (src/policy.ts): the Delivr id goes into the file only for a Texas visitor with no GPC who
  // is not a bot or a data center. Everyone else gets the same pixel with no partner id, so Delivr's
  // script never loads for them. The answer is per visitor, so the file is never shared from a cache.
  const ctx = readRequestContext(c.req.raw);
  const gate = requestGate({ ...ctx, asnClass: classifyAsn(ctx.asn, ctx.asOrganization) }, allowedStates(c.env));
  const gateTag = gate.ok ? 'pass' : gate.reason;
  // A page that copied the tag onto a domain the site never registered gets no partner id. The Referer
  // is the page that loaded the script; with none (a strict Referrer-Policy) nothing changes.
  const referer = c.req.header('referer');
  const onSite = !referer || allowedOrigin(referer, site.allowedDomains) !== null;
  const partner = gate.ok && onSite ? (site.delivrPixelId ?? '') : '';
  const etag = `"${PIXEL_BUILD_HASH}-${siteKey}-${gateTag}${partner ? '-' + partner.slice(0, 8) : ''}"`;
  c.header('Cache-Control', PIXEL_CACHE_CONTROL);
  c.header('Vary', 'Sec-GPC');
  c.header('X-Yardsign-Gate', gateTag);
  c.header('Cross-Origin-Resource-Policy', 'cross-origin');
  c.header('ETag', etag);
  if (c.req.header('if-none-match') === etag) return c.body(null, 304);
  return c.body(renderPixel(siteKey, collectUrl(c.env, c.req.url), partner));
});
