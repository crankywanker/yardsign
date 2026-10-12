import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { hashEmail, insertVisit, isOptedOut, type DeliveryRow, type LeadRow, type NewVisit, type VisitRow } from '@yardsign/db';
import { MockProvider } from '@yardsign/identity';
import { app } from '../src/app';
import { classifyAsn, resolveVerdict } from '../src/demo';
import { createLogger } from '../src/log';
import { pollUnresolvedVisits, processVisit } from '../src/resolution';
import { HUMAN_UA, PLANO_CF, SITE_ID, postCollect, uuidFrom, viewPayload } from './helpers';

const log = createLogger({ req_id: 'test' });

describe('classifyAsn and the verdict', () => {
  it('classifies common networks', () => {
    expect(classifyAsn(7018, 'AT&T Internet Services')).toBe('residential');
    expect(classifyAsn(21928, 'T-Mobile USA')).toBe('mobile');
    expect(classifyAsn(16509, 'Amazon.com')).toBe('hosting');
    expect(classifyAsn(13335, 'Cloudflare iCloud Private Relay')).toBe('relay');
    expect(classifyAsn(1234, 'Some Small Business ISP')).toBe('business');
    expect(classifyAsn(null, null)).toBe('unknown');
  });

  it('tries Texas on any network, data centers and unknown regions too; skips GPC, non-US and other states', () => {
    const base = { local: false, gpc: false, country: 'US', region: 'TX', asnClass: 'residential' as const };
    expect(resolveVerdict(base)).toMatchObject({ wouldTry: true, reason: null });
    for (const asnClass of ['business', 'unknown', 'mobile', 'relay', 'hosting'] as const) expect(resolveVerdict({ ...base, asnClass }).wouldTry, asnClass).toBe(true);
    expect(resolveVerdict({ ...base, gpc: true }).reason).toBe('gpc');
    expect(resolveVerdict({ ...base, country: 'MX' }).reason).toBe('non_us');
    expect(resolveVerdict({ ...base, region: 'CA' }).reason).toBe('not_allowed_state');
    expect(resolveVerdict({ ...base, region: 'tx' }).wouldTry).toBe(true);
    expect(resolveVerdict({ ...base, region: null }).wouldTry).toBe(true);
    expect(resolveVerdict({ ...base, bot: true }).reason).toBe('bot_or_datacenter');
    expect(resolveVerdict({ ...base, local: true }).reason).toBe('local_dev');
  });

  it('never says Texas when the state is unknown', () => {
    const base = { local: false, gpc: false, country: 'US', region: 'TX', asnClass: 'residential' as const };
    expect(resolveVerdict(base).why).toContain('You appear to be in Texas');
    for (const region of [null, '', 'Somewhere']) {
      const v = resolveVerdict({ ...base, region });
      expect(v.wouldTry).toBe(true);
      expect(v.why).toBe('We could not tell which state you are in, so we would try.');
    }
  });
});

describe('public pages', () => {
  it('serves the stylesheet and legal pages', async () => {
    expect((await app.fetch(new Request('http://localhost/style.css'), env)).headers.get('content-type')).toContain('text/css');
    for (const path of ['/privacy', '/terms', '/optout']) {
      const res = await app.fetch(new Request(`http://localhost${path}`), env);
      expect(res.status, path).toBe(200);
      const html = await res.text();
      expect(html).toContain('Yardsign');
      expect(html).not.toMatch(/codename/i);
    }
  });

  it('demo.json returns the view and verdict for the connection', async () => {
    const res = await app.fetch(new Request('http://localhost/demo.json', { cf: { ...PLANO_CF, asOrganization: 'T-Mobile USA' }, headers: { 'user-agent': HUMAN_UA, 'cf-connecting-ip': '203.0.113.7' } } as RequestInit), env);
    expect(res.status).toBe(200);
    const body = await res.json<{ view: { city: string; network: string }; verdict: { wouldTry: boolean; why: string } }>();
    expect(body.view.city).toBe('Plano');
    expect(body.view.network).toBe('Cell data');
    expect(body.verdict.wouldTry).toBe(true);
    expect(body.verdict.why).toContain('Texas');
  });

  it('the demo shows local time from the connection time zone', async () => {
    const res = await app.fetch(new Request('http://localhost/demo.json', { cf: { ...PLANO_CF, timezone: 'America/Chicago' }, headers: { 'user-agent': HUMAN_UA, 'cf-connecting-ip': '203.0.113.8' } } as RequestInit), env);
    const body = await res.json<{ view: { timezone: string | null; localTime: string | null } }>();
    expect(body.view.timezone).toBe('America/Chicago');
    expect(body.view.localTime).toMatch(/^\d{1,2}:\d{2}\s?[AP]M$/);
    const page = await app.fetch(new Request('http://localhost/', { cf: { ...PLANO_CF, timezone: 'America/Chicago' } } as RequestInit), env);
    expect(await page.text()).toMatch(/\d{1,2}:\d{2}\s?[AP]M/);
  });

  it('the landing page still renders, without our pixel, when the database is down', async () => {
    const down = { ...env, DB: { prepare: () => { throw new Error('D1 is down'); } } as unknown as D1Database };
    const res = await app.fetch(new Request('http://localhost/', { cf: PLANO_CF } as RequestInit), down);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Know who drove past.');
    expect(html).not.toContain('/p/TRYYARDSIGN.js');
  });

  it('demo.json is rate limited per ip', async () => {
    let last = 200;
    for (let i = 0; i < 32; i++) {
      const res = await app.fetch(new Request('http://localhost/demo.json', { cf: PLANO_CF, headers: { 'cf-connecting-ip': '203.0.113.9' } } as unknown as RequestInit), env);
      last = res.status;
    }
    expect(last).toBe(429);
  });

  it('checkout with an empty form is a validation error, not a crash', async () => {
    const res = await app.fetch(new Request('http://localhost/checkout', { method: 'POST' }), env);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('valid email');
  });
});

describe('resolution gates on real visits', () => {
  it('stores gpc and asn class on the visit and skips resolution with a reason', async () => {
    const p = viewPayload({ vid: uuidFrom(21) });
    await (await postCollect(p, { gpc: true })).ctx.settle();
    const v = await env.DB.prepare('SELECT * FROM visits WHERE id = ?').bind(p.id).first<VisitRow>();
    expect(v?.gpc).toBe(1);
    expect(v?.asn_class).toBe('residential');
    expect(v?.asn_org).toBe('AT&T Internet Services');
    const r = await processVisit(env, p.id as string, log);
    expect(r).toMatchObject({ outcome: 'skipped', skipReason: 'gpc' });
    expect((await env.DB.prepare('SELECT skip_reason FROM visits WHERE id = ?').bind(p.id).first<{ skip_reason: string }>())?.skip_reason).toBe('gpc');
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM identity_requests').first<{ n: number }>()).toEqual({ n: 0 });
  });

  it('skips California and Mexico without calling the provider; tries Texas cell data and data centers', async () => {
    const mobile = viewPayload({ vid: uuidFrom(22) });
    await (await postCollect(mobile, { cf: { ...PLANO_CF, asOrganization: 'Verizon Wireless' } })).ctx.settle();
    const cali = viewPayload({ vid: uuidFrom(23) });
    await (await postCollect(cali, { cf: { ...PLANO_CF, regionCode: 'CA', city: 'Fresno' } })).ctx.settle();
    const mexico = viewPayload({ vid: uuidFrom(24) });
    await (await postCollect(mexico, { cf: { ...PLANO_CF, country: 'MX' } })).ctx.settle();
    const dc = viewPayload({ vid: uuidFrom(25) });
    await (await postCollect(dc, { cf: { ...PLANO_CF, asOrganization: 'Amazon.com' } })).ctx.settle();
    expect(await pollUnresolvedVisits(env, log)).toBe(4);
    const reasons = (await env.DB.prepare('SELECT skip_reason FROM visits WHERE skip_reason IS NOT NULL').all<{ skip_reason: string }>()).results.map((r) => r.skip_reason).sort();
    expect(reasons).toEqual(['non_us', 'not_allowed_state']);
    // The Texas cell-data and data-center visits reached the provider.
    const sent = await env.DB.prepare('SELECT v.visitor_id FROM identity_requests r JOIN visits v ON v.id = r.visit_id').all<{ visitor_id: string }>();
    expect(sent.results.map((r) => r.visitor_id).sort()).toEqual([uuidFrom(22), uuidFrom(25)].sort());
  });
});

describe('opt-out', () => {
  function visitRow(visitorId: string): NewVisit {
    return {
      id: crypto.randomUUID(), site_id: SITE_ID, visitor_id: visitorId, session_id: 'sess_abcdefgh', url: 'http://localhost:3000/', path: '/',
      referrer: null, title: null, ip_hash: 'h', ip_raw: null, country: 'US', region: 'TX', city: 'Plano', postal: '75024', asn: 7018, colo: null,
      lat: null, lng: null, user_agent: 'Mozilla/5.0', device: '{}', screen: '{}', timezone: null, language: null, bot_score: null,
      occurred_at: Date.now(), created_at: Date.now(), gpc: 0, asn_org: 'AT&T', asn_class: 'residential',
    };
  }
  async function resolvable(): Promise<{ vid: string; email: string }> {
    const p = new MockProvider();
    for (let i = 0; i < 500; i++) {
      const vid = uuidFrom(i);
      const r = await p.resolve({ visitor_id: vid, visit_id: 'x', site_id: SITE_ID, ip: null, ip_hash: 'h', user_agent: null, geo: { country: null, region: null, city: null, postal: null, lat: null, lng: null, asn: null }, occurred_at: 0, created_at: 0 });
      if (r.status === 'resolved' && r.lead?.email) return { vid, email: r.lead.email };
    }
    throw new Error('mock never resolved');
  }

  it('deletes existing leads for that email and blocks future matches', async () => {
    const { vid, email } = await resolvable();
    const v = visitRow(vid);
    await insertVisit(env.DB, v);
    const r = await processVisit(env, v.id, log);
    expect(r.outcome).toBe('resolved');
    const lead = await env.DB.prepare('SELECT * FROM leads WHERE id = ?').bind(r.leadId).first<LeadRow>();
    expect(lead?.email_hash).toBe(await hashEmail(email));

    // Gmail-style variations of the same address must map to the same hash.
    expect(await hashEmail('Jo.Hn+tag@gmail.com')).toBe(await hashEmail('john@gmail.com'));

    const form = new URLSearchParams({ email: email.toUpperCase() });
    const res = await app.fetch(new Request('http://localhost/optout', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form }), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("You're opted out");
    expect(await isOptedOut(env.DB, await hashEmail(email))).toBe(true);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM leads').first<{ n: number }>()).toEqual({ n: 0 });
    expect((await env.DB.prepare('SELECT * FROM deliveries').all<DeliveryRow>()).results).toHaveLength(0);
    // The address-level score (it holds the house's map point) goes with the lead; the visit's ZIP-level row stays.
    const scores = await env.DB.prepare('SELECT lead_id FROM lead_scores WHERE visit_id = ?').bind(v.id).all<{ lead_id: string | null }>();
    expect(scores.results.every((s) => s.lead_id === null)).toBe(true);
    // The raw answer behind the lead keeps only its row count.
    const req = await env.DB.prepare('SELECT response_payload FROM identity_requests WHERE visit_id = ?').bind(v.id).first<{ response_payload: string }>();
    expect(JSON.parse(req!.response_payload)).toMatchObject({ opted_out: 1 });
    expect(req!.response_payload).not.toContain('@');

    // 31 days later the same browser shows up again: skipped before any lookup, no lead, no delivery.
    const later = visitRow(vid);
    later.created_at = Date.now() + 31 * 24 * 3600 * 1000;
    await insertVisit(env.DB, later);
    await env.DB.prepare("UPDATE identity_requests SET created_at = created_at - 40 * 24 * 3600 * 1000").run();
    const requestsBefore = await env.DB.prepare('SELECT COUNT(*) AS n FROM identity_requests').first<{ n: number }>();
    const r2 = await processVisit(env, later.id, log);
    expect(r2).toMatchObject({ outcome: 'skipped', skipReason: 'opted_out' });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM identity_requests').first<{ n: number }>()).toEqual(requestsBefore);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM leads').first<{ n: number }>()).toEqual({ n: 0 });
    expect((await env.DB.prepare('SELECT skip_reason FROM visits WHERE id = ?').bind(later.id).first<{ skip_reason: string }>())?.skip_reason).toBe('opted_out');
  });

  it('rejects a bad email', async () => {
    const res = await app.fetch(new Request('http://localhost/optout', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'nope' }) }), env);
    expect(res.status).toBe(400);
  });
});
