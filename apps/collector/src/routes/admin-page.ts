/**
 * The operator page: GET /admin and GET /admin/leads/:id. HTML, read-only, the owner only.
 * Cloudflare Access fronts the route; the Worker verifies the Access JWT itself (src/access.ts)
 * and refuses with 403 when it is missing or bad. The JSON admin API in routes/admin.ts keeps
 * its bearer token and is not touched by this middleware.
 */
import { Hono, type MiddlewareHandler } from 'hono';
import { DAY_MS, getIdentityRequest, getLead, getSiteById, getVisit, listDeliveriesForLead, listRecentPathsForVisitor, parseJson } from '@yardsign/db';
import { ACCESS_JWT_HEADER, verifyAccessJwt } from '../access';
import { adminStats } from '../admin-stats';
import { allowedStates } from '../policy';
import { spendCaps } from '../spend';
import type { Env } from '../env';
import type { Logger } from '../log';
import { adminForbiddenPage, adminLeadPage, adminPage, type AdminCtx } from '../pages/admin';
import { APP_NAME } from '../plans';

type Vars = { log: Logger; requestId: string };
export const adminPageRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

const PRIVATE_HEADERS: Record<string, string> = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' };

/** Verify the Access token or stop with 403. Logs the reason, never the token or the email. */
const requireAccess: MiddlewareHandler<{ Bindings: Env; Variables: Vars }> = async (c, next) => {
  for (const [k, v] of Object.entries(PRIVATE_HEADERS)) c.header(k, v);
  const verdict = await verifyAccessJwt(c.req.header(ACCESS_JWT_HEADER), { teamDomain: c.env.CF_ACCESS_TEAM_DOMAIN, aud: c.env.CF_ACCESS_AUD });
  if (!verdict.ok) {
    c.get('log').warn('admin page: refused', { reason: verdict.reason });
    return c.html(adminForbiddenPage(APP_NAME), 403);
  }
  await next();
};

function ctxFor(env: Env): AdminCtx {
  return { app: APP_NAME, provider: (env.IDENTITY_PROVIDER ?? 'mock').toLowerCase(), buildSha: env.BUILD_SHA ?? 'dev' };
}

adminPageRoutes.get('/admin', requireAccess, async (c) => {
  const st = await adminStats(c.env.DB, { allowed: allowedStates(c.env), caps: spendCaps(c.env) });
  return c.html(adminPage(ctxFor(c.env), st));
});

const UUID = /^[0-9a-f-]{8,64}$/i;

adminPageRoutes.get('/admin/leads/:id', requireAccess, async (c) => {
  const id = c.req.param('id');
  if (!UUID.test(id)) return c.notFound();
  const lead = await getLead(c.env.DB, id);
  if (!lead) return c.notFound();
  const db = c.env.DB;
  // Pages viewed in the week before the lead was made, so an older lead still shows what led to it.
  const pagesBeforeLead = listRecentPathsForVisitor(db, lead.site_id, lead.visitor_id, 7 * DAY_MS, lead.created_at);
  const [site, pages, deliveries, req] = await Promise.all([getSiteById(db, lead.site_id), pagesBeforeLead, listDeliveriesForLead(db, lead.id), getIdentityRequest(db, lead.identity_request_id)]);
  const visit = req ? await getVisit(db, req.visit_id) : null;
  const connection = visit?.city ? [visit.city, visit.region].filter(Boolean).join(', ') : null;
  const street = [lead.address_line1, lead.address_line2].filter(Boolean).join(', ');
  const cityState = [lead.city, lead.state].filter(Boolean).join(', ');
  return c.html(
    adminLeadPage(ctxFor(c.env), {
      siteName: site?.name ?? lead.site_id,
      name: [lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'Name not available',
      address: [street, cityState, lead.zip].filter(Boolean).join(' · ') || 'Address not available',
      phone: lead.phone,
      email: lead.email,
      confidence: lead.confidence,
      pages,
      connection,
      seenAt: lead.created_at,
      mock: parseJson<{ mock?: unknown }>(lead.extra, {}).mock === true,
      deliveries,
    }),
  );
});
