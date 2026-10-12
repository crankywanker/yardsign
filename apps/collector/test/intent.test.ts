import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DAY_MS, completeIdentityRequest, insertDelivery, insertIdentityRequest, insertLead, insertVisit, updateDelivery, type NewVisit } from '@yardsign/db';
import { intentLevel, intentLine, isKeyPage, visitorIntent } from '../src/intent';
import { createLogger } from '../src/log';
import { processVisit } from '../src/resolution';
import { SITE_ID, uuidFrom } from './helpers';

const log = createLogger({ req_id: 'test' });

function visitRow(visitorId: string, createdAt: number, session = 'sess_abcdefgh', path = '/'): NewVisit {
  return {
    id: crypto.randomUUID(), site_id: SITE_ID, visitor_id: visitorId, session_id: session, url: `http://localhost:3000${path}`, path,
    referrer: null, title: null, ip_hash: 'h', ip_raw: '203.0.113.10', country: 'US', region: 'TX', city: 'Plano', postal: '75024', asn: 7018, colo: 'DFW',
    lat: 33.0198, lng: -96.6989, user_agent: 'Mozilla/5.0', device: '{}', screen: '{}', timezone: 'America/Chicago', language: 'en-US', bot_score: null,
    occurred_at: createdAt, created_at: createdAt, gpc: 0, asn_org: 'AT&T', asn_class: 'residential',
  };
}

describe('buying intent', () => {
  it('spots pages people open when they are close to hiring', () => {
    for (const p of ['/financing', '/insurance-claims', '/pricing', '/get-a-quote', '/contact', '/schedule-inspection']) expect(isKeyPage(p)).toBe(true);
    for (const p of ['/', '/about', '/blog/hail-season']) expect(isKeyPage(p)).toBe(false);
  });

  it('scores repeat visits, days and key pages', () => {
    expect(intentLevel(1, 1, 0)).toBe('low');
    expect(intentLevel(2, 1, 0)).toBe('medium');
    expect(intentLevel(1, 1, 1)).toBe('medium');
    expect(intentLevel(3, 2, 0)).toBe('high');
    expect(intentLevel(2, 2, 1)).toBe('high');
  });

  it('reads one visitor on one site from the visits table', async () => {
    const vid = uuidFrom(2001);
    const now = Date.now();
    await insertVisit(env.DB, visitRow(vid, now - 3 * DAY_MS, 'sess_one_aaaaaaa', '/'));
    await insertVisit(env.DB, visitRow(vid, now - 3 * DAY_MS + 60_000, 'sess_one_aaaaaaa', '/financing'));
    await insertVisit(env.DB, visitRow(vid, now - DAY_MS, 'sess_two_bbbbbbb', '/insurance-claims'));
    await insertVisit(env.DB, visitRow(vid, now - 60_000, 'sess_three_cccccc', '/'));
    const i = await visitorIntent(env.DB, SITE_ID, vid, now);
    expect(i).toMatchObject({ level: 'high', visits: 3, days: 3, views: 4 });
    expect(i.keyPages).toEqual(['/insurance-claims', '/financing']);
    expect(intentLine(i)).toBe('High: 3 visits over 3 days, looked at /insurance-claims, /financing');
  });
});

describe("they're back alert", () => {
  const EMAIL_ENV = { EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 'k', EMAIL_FROM: 'Yardsign <leads@example.com>' };
  afterEach(() => vi.restoreAllMocks());

  /** A lead from two days ago and its first card: delivered, or held back over quota. */
  async function knownLead(vid: string, at: number, card: 'delivered' | 'over_quota' = 'delivered'): Promise<void> {
    await env.DB.prepare('UPDATE sites SET lead_email = ? WHERE id = ?').bind('owner@example.com', SITE_ID).run();
    const v = visitRow(vid, at, 'sess_first_visit1');
    await insertVisit(env.DB, v);
    await env.DB.prepare('UPDATE visits SET resolve_attempted_at = ? WHERE id = ?').bind(at, v.id).run();
    const req = await insertIdentityRequest(env.DB, { visitId: v.id, provider: 'stub', requestPayload: {} }, at);
    await completeIdentityRequest(env.DB, req, { status: 'resolved', responsePayload: null, costCents: 0 });
    const lead = await insertLead(env.DB, { siteId: SITE_ID, visitorId: vid, identityRequestId: req, fields: { first_name: 'Pat', last_name: 'Doe', address_line1: '1 Main St', email: 'pat@example.com' }, confidence: 0.8 }, at);
    const d = await insertDelivery(env.DB, { leadId: lead.id, channel: 'email', payload: {} }, at);
    await updateDelivery(env.DB, d, card === 'delivered' ? { status: 'delivered', lastError: null, deliveredAt: at } : { status: 'skipped', lastError: 'over_quota', deliveredAt: null });
  }

  const stub = { name: 'stub', resolve: async () => ({ status: 'no_match' as const }) };
  const returnRows = async () =>
    (await env.DB.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE channel = 'email:return'").first<{ n: number }>())?.n;

  it('emails the contractor once when a known lead starts a new visit, and not again that day', async () => {
    const sent: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      sent.push(String((init as RequestInit).body));
      return new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 });
    });
    const vid = uuidFrom(2101);
    const now = Date.now();
    await knownLead(vid, now - 2 * DAY_MS);

    const back = visitRow(vid, now - 60_000, 'sess_came_back_1', '/financing');
    await insertVisit(env.DB, back);
    expect((await processVisit({ ...env, ...EMAIL_ENV }, back.id, log, stub, undefined, () => now)).outcome).toBe('deduped');
    expect(await returnRows()).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('Back on your site: Pat Doe');

    // A second page in the same visit, and a new visit later the same day: no second email.
    const samePage = visitRow(vid, now - 30_000, 'sess_came_back_1', '/pricing');
    await insertVisit(env.DB, samePage);
    await processVisit({ ...env, ...EMAIL_ENV }, samePage.id, log, stub, undefined, () => now);
    const later = visitRow(vid, now - 10_000, 'sess_came_back_2', '/');
    await insertVisit(env.DB, later);
    await processVisit({ ...env, ...EMAIL_ENV }, later.id, log, stub, undefined, () => now);
    expect(await returnRows()).toBe(1);
  });

  it('never alerts for a visitor we have no lead for, or one a privacy gate skips', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 'x' }), { status: 200 }));
    const now = Date.now();
    const stranger = visitRow(uuidFrom(2201), now - 60_000, 'sess_stranger_01');
    await insertVisit(env.DB, stranger);
    await processVisit({ ...env, ...EMAIL_ENV }, stranger.id, log, stub, undefined, () => now);

    const vid = uuidFrom(2202);
    await knownLead(vid, now - 2 * DAY_MS);
    const gpc = { ...visitRow(vid, now - 60_000, 'sess_gpc_visit_01'), gpc: 1 };
    await insertVisit(env.DB, gpc);
    expect((await processVisit({ ...env, ...EMAIL_ENV }, gpc.id, log, stub, undefined, () => now)).skipReason).toBe('gpc');
    expect(await returnRows()).toBe(0);
  });

  it('never emails a lead that was held back over quota', async () => {
    const sent: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      sent.push(String((init as RequestInit).body));
      return new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 });
    });
    const vid = uuidFrom(2401);
    const now = Date.now();
    await knownLead(vid, now - 2 * DAY_MS, 'over_quota');
    const back = visitRow(vid, now - 60_000, 'sess_came_back_9', '/financing');
    await insertVisit(env.DB, back);
    expect((await processVisit({ ...env, ...EMAIL_ENV }, back.id, log, stub, undefined, () => now)).outcome).toBe('deduped');
    expect(await returnRows()).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('a re-check that finds no more than the partial lead sends no second card', async () => {
    const now = Date.now();
    const vid = uuidFrom(2301);
    const first = visitRow(vid, now - 2 * DAY_MS, 'sess_partial_one');
    await insertVisit(env.DB, first);
    await env.DB.prepare('UPDATE visits SET resolve_attempted_at = ? WHERE id = ?').bind(now - 2 * DAY_MS, first.id).run();
    const req = await insertIdentityRequest(env.DB, { visitId: first.id, provider: 'stub', requestPayload: {} }, now - 2 * DAY_MS);
    await completeIdentityRequest(env.DB, req, { status: 'resolved', responsePayload: null, costCents: 0 });
    await insertLead(env.DB, { siteId: SITE_ID, visitorId: vid, identityRequestId: req, fields: { email: 'someone@example.com', state: 'TX' }, confidence: 0.7 }, now - 2 * DAY_MS);

    const again = visitRow(vid, now - 60_000, 'sess_partial_two');
    await insertVisit(env.DB, again);
    const emailOnly = { name: 'stub', resolve: async () => ({ status: 'resolved' as const, lead: { email: 'someone@example.com', state: 'TX' }, confidence: 0.7 }) };
    const r = await processVisit(env, again.id, log, emailOnly, undefined, () => now);
    expect(r.outcome).toBe('resolved');
    expect(r.leadId).toBeUndefined();
    const leads = await env.DB.prepare('SELECT COUNT(*) AS n FROM leads WHERE visitor_id = ?').bind(vid).first<{ n: number }>();
    expect(leads?.n).toBe(1);
  });
});
