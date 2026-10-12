import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { DAY_MS, completeIdentityRequest, hadIdentityRequestRecently, insertIdentityRequest, insertLead, insertVisit, wasResolvedRecently, type NewVisit } from '@yardsign/db';
import { MockProvider } from '@yardsign/identity';
import { createLogger } from '../src/log';
import { processVisit } from '../src/resolution';
import { SITE_ID, uuidFrom } from './helpers';

const log = createLogger({ req_id: 'test' });

function visitRow(visitorId: string, createdAt: number): NewVisit {
  return {
    id: crypto.randomUUID(),
    site_id: SITE_ID,
    visitor_id: visitorId,
    session_id: 'sess_abcdefgh',
    url: 'http://localhost:3000/',
    path: '/',
    referrer: null,
    title: null,
    ip_hash: 'h',
    ip_raw: '203.0.113.10',
    country: 'US',
    region: 'TX',
    city: 'Plano',
    postal: '75024',
    asn: 7018,
    colo: 'DFW',
    lat: 33.0198,
    lng: -96.6989,
    user_agent: 'Mozilla/5.0',
    device: '{}',
    screen: '{}',
    timezone: 'America/Chicago',
    language: 'en-US',
    bot_score: null,
    occurred_at: createdAt,
    created_at: createdAt,
    gpc: 0,
    asn_org: 'AT&T',
    asn_class: 'residential',
  };
}

/** First visitor id the mock resolves. */
async function resolvableVisitorId(): Promise<string> {
  const p = new MockProvider();
  for (let i = 0; i < 500; i++) {
    const vid = uuidFrom(i);
    const r = await p.resolve({ visitor_id: vid, visit_id: 'x', site_id: SITE_ID, ip: null, ip_hash: 'h', user_agent: null, geo: { country: null, region: null, city: null, postal: null, lat: null, lng: null, asn: null }, occurred_at: 0, created_at: 0 });
    if (r.status === 'resolved') return vid;
  }
  throw new Error('mock never resolved');
}

describe('30-day dedupe rule', () => {
  const vid = uuidFrom(42);
  const now = Date.UTC(2026, 9, 5);

  it('is false with no history', async () => {
    expect(await wasResolvedRecently(env.DB, SITE_ID, vid, 30 * DAY_MS, now)).toBe(false);
  });

  it('is true when a lead exists inside the window and false outside it', async () => {
    const v = visitRow(vid, now - 10 * DAY_MS);
    await insertVisit(env.DB, v);
    const reqId = await insertIdentityRequest(env.DB, { visitId: v.id, provider: 'mock', requestPayload: {} }, now - 10 * DAY_MS);
    await insertLead(env.DB, { siteId: SITE_ID, visitorId: vid, identityRequestId: reqId, fields: { first_name: 'A' }, confidence: 0.9 }, now - 10 * DAY_MS);
    expect(await wasResolvedRecently(env.DB, SITE_ID, vid, 30 * DAY_MS, now)).toBe(true);
    expect(await wasResolvedRecently(env.DB, SITE_ID, vid, 30 * DAY_MS, now + 21 * DAY_MS)).toBe(false);
    // A different site is a different visitor.
    expect(await wasResolvedRecently(env.DB, 'site_other', vid, 30 * DAY_MS, now)).toBe(false);
  });

  it('is true after a recent no_match, but false after an error', async () => {
    const a = visitRow(vid, now - 5 * DAY_MS);
    await insertVisit(env.DB, a);
    const reqA = await insertIdentityRequest(env.DB, { visitId: a.id, provider: 'mock', requestPayload: {} }, now - 5 * DAY_MS);
    await completeIdentityRequest(env.DB, reqA, { status: 'error', responsePayload: null, costCents: null });
    expect(await wasResolvedRecently(env.DB, SITE_ID, vid, 30 * DAY_MS, now)).toBe(false);

    const b = visitRow(vid, now - 4 * DAY_MS);
    await insertVisit(env.DB, b);
    const reqB = await insertIdentityRequest(env.DB, { visitId: b.id, provider: 'mock', requestPayload: {} }, now - 4 * DAY_MS);
    await completeIdentityRequest(env.DB, reqB, { status: 'no_match', responsePayload: null, costCents: 5 });
    expect(await wasResolvedRecently(env.DB, SITE_ID, vid, 30 * DAY_MS, now)).toBe(true);
  });

  it('processVisit calls the provider once per visitor per 30 days', async () => {
    const rvid = await resolvableVisitorId();
    const first = visitRow(rvid, Date.now() - 1000);
    const second = visitRow(rvid, Date.now());
    await insertVisit(env.DB, first);
    await insertVisit(env.DB, second);

    const r1 = await processVisit(env, first.id, log);
    expect(r1.outcome).toBe('resolved');
    expect(r1.leadId).toBeTruthy();

    const r2 = await processVisit(env, second.id, log);
    expect(r2.outcome).toBe('deduped');

    const again = await processVisit(env, first.id, log);
    expect(again.outcome).toBe('already_attempted');

    const reqs = await env.DB.prepare('SELECT COUNT(*) AS n FROM identity_requests').first<{ n: number }>();
    expect(reqs?.n).toBe(1);
    const leads = await env.DB.prepare('SELECT COUNT(*) AS n FROM leads').first<{ n: number }>();
    expect(leads?.n).toBe(1);
  });
});

describe('dedupe rules are per provider', () => {
  const now = Date.now();

  it('a mock answer does not count for delivr, and the other way round', async () => {
    const vid = uuidFrom(777);
    const v = visitRow(vid, now - 5 * DAY_MS);
    await insertVisit(env.DB, v);
    const req = await insertIdentityRequest(env.DB, { visitId: v.id, provider: 'mock', requestPayload: {} }, now - 5 * DAY_MS);
    await completeIdentityRequest(env.DB, req, { status: 'resolved', responsePayload: null, costCents: 0 });
    await insertLead(env.DB, { siteId: SITE_ID, visitorId: vid, identityRequestId: req, fields: { first_name: 'Fake' }, confidence: 0.9 }, now - 5 * DAY_MS);
    expect(await wasResolvedRecently(env.DB, SITE_ID, vid, 30 * DAY_MS, now)).toBe(true); // any provider
    expect(await wasResolvedRecently(env.DB, SITE_ID, vid, 30 * DAY_MS, now, 'mock')).toBe(true);
    expect(await wasResolvedRecently(env.DB, SITE_ID, vid, 30 * DAY_MS, now, 'delivr')).toBe(false);
    expect(await hadIdentityRequestRecently(env.DB, SITE_ID, vid, 6 * DAY_MS, now, 'delivr')).toBe(false);
    expect(await hadIdentityRequestRecently(env.DB, SITE_ID, vid, 6 * DAY_MS, now, 'mock')).toBe(true);
  });

  it('processVisit with a paid provider is not blocked by an old mock lead', async () => {
    const vid = uuidFrom(778);
    const earlier = visitRow(vid, now - 2 * DAY_MS);
    await insertVisit(env.DB, earlier);
    const req = await insertIdentityRequest(env.DB, { visitId: earlier.id, provider: 'mock', requestPayload: {} }, now - 2 * DAY_MS);
    await completeIdentityRequest(env.DB, req, { status: 'resolved', responsePayload: null, costCents: 0 });
    await insertLead(env.DB, { siteId: SITE_ID, visitorId: vid, identityRequestId: req, fields: { first_name: 'Fake' }, confidence: 0.9 }, now - 2 * DAY_MS);
    await env.DB.prepare('UPDATE visits SET resolve_attempted_at = ? WHERE id = ?').bind(now - 2 * DAY_MS, earlier.id).run();
    // An engaged session today: two views.
    const a = visitRow(vid, now - 25 * 60_000);
    const b = { ...visitRow(vid, now - 20 * 60_000), session_id: a.session_id };
    await insertVisit(env.DB, a);
    await insertVisit(env.DB, b);
    let calls = 0;
    const paid = { name: 'delivr', maxCostCentsPerCall: 2.5, resolve: async () => { calls++; return { status: 'no_match' as const }; } };
    expect((await processVisit(env, b.id, log, paid, undefined, () => now)).outcome).toBe('no_match');
    expect(calls).toBe(1);
  });
});

describe('provider minVisitAgeMs', () => {
  it('leaves a young visit untouched so the next poll retries it', async () => {
    const now = Date.now();
    const v = visitRow(uuidFrom(900), now - 60_000);
    await insertVisit(env.DB, v);
    const slow = { name: 'slow', minVisitAgeMs: 10 * 60_000, resolve: async () => ({ status: 'no_match' as const }) };
    expect((await processVisit(env, v.id, log, slow, undefined, () => now)).outcome).toBe('deferred');
    const row = await env.DB.prepare('SELECT resolve_attempted_at FROM visits WHERE id = ?').bind(v.id).first<{ resolve_attempted_at: number | null }>();
    expect(row?.resolve_attempted_at).toBeNull();
    // Old enough now: the provider is asked and the visit is marked.
    expect((await processVisit(env, v.id, log, slow, undefined, () => now + 11 * 60_000)).outcome).toBe('no_match');
  });
});

describe('re-check window for partial leads and misses', () => {
  const now = Date.now();
  const full = { status: 'resolved' as const, lead: { first_name: 'Pat', last_name: 'Doe', address_line1: '1 Main St', city: 'Plano', state: 'TX', zip: '75024' }, confidence: 0.8 };

  async function history(vid: string, daysAgo: number, kind: 'partial' | 'full' | 'no_match'): Promise<void> {
    const at = now - daysAgo * DAY_MS;
    const v = visitRow(vid, at);
    await insertVisit(env.DB, v);
    await env.DB.prepare('UPDATE visits SET resolve_attempted_at = ? WHERE id = ?').bind(at, v.id).run();
    const req = await insertIdentityRequest(env.DB, { visitId: v.id, provider: 'stub', requestPayload: {} }, at);
    await completeIdentityRequest(env.DB, req, { status: kind === 'no_match' ? 'no_match' : 'resolved', responsePayload: null, costCents: 0 });
    if (kind === 'partial') await insertLead(env.DB, { siteId: SITE_ID, visitorId: vid, identityRequestId: req, fields: { email: 'someone@example.com' }, confidence: 0.7 }, at);
    if (kind === 'full') await insertLead(env.DB, { siteId: SITE_ID, visitorId: vid, identityRequestId: req, fields: full.lead, confidence: 0.8 }, at);
  }

  async function returnVisit(vid: string): Promise<{ outcome: string; calls: number }> {
    const v = visitRow(vid, now - 60_000);
    await insertVisit(env.DB, v);
    let calls = 0;
    const stub = { name: 'stub', resolve: async () => { calls++; return full; } };
    const r = await processVisit(env, v.id, log, stub, undefined, () => now);
    return { outcome: r.outcome, calls };
  }

  it('looks again when an email-only match is inside the window, and sends a full lead', async () => {
    const vid = uuidFrom(1001);
    await history(vid, 3, 'partial');
    expect(await returnVisit(vid)).toEqual({ outcome: 'resolved', calls: 1 });
  });

  it('looks again after a miss inside the window', async () => {
    const vid = uuidFrom(1002);
    await history(vid, 3, 'no_match');
    expect(await returnVisit(vid)).toEqual({ outcome: 'resolved', calls: 1 });
  });

  it('stops looking once the window has passed', async () => {
    const vid = uuidFrom(1003);
    await history(vid, 8, 'partial');
    expect(await returnVisit(vid)).toEqual({ outcome: 'deduped', calls: 0 });
  });

  it('a full lead still closes the visitor for 30 days', async () => {
    const vid = uuidFrom(1004);
    await history(vid, 1, 'full');
    expect(await returnVisit(vid)).toEqual({ outcome: 'deduped', calls: 0 });
  });

  it('the window is a setting', async () => {
    const vid = uuidFrom(1005);
    await history(vid, 8, 'partial');
    const v = visitRow(vid, now - 60_000);
    await insertVisit(env.DB, v);
    const stub = { name: 'stub', resolve: async () => full };
    expect((await processVisit({ ...env, RECHECK_DAYS: '14' }, v.id, log, stub, undefined, () => now)).outcome).toBe('resolved');
  });
});
