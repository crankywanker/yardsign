import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { insertVisit, updateSiteDelivery, upsertHailEvents, type HailEventRow, type LeadRow, type LeadScoreRow, type NewVisit, type VisitRow } from '@yardsign/db';
import { MockHailSource, NOAA_ID_PREFIX, SCORING, scoreAndStore, scoreVisit, syncHailEvents } from '@yardsign/scoring';
import { MockProvider } from '@yardsign/identity';
import { toLeadPayload } from '../src/delivery';
import { agoLabel, hailFacts, hailFactsFromScore, hailHtml, hailJson, placeFrom, type HailFacts } from '../src/email/hail';
import { app } from '../src/app';
import { sortLeads, type LeadView } from '../src/pages/dashboard';
import { webhookBody } from '../src/webhook';
import { leadHtml, leadSubject, leadText } from '../src/email/lead-card';
import { HAIL_SYNC_BBOX, HAIL_SYNC_LOOKBACK_MS, cronLookbackMs, runHailSync } from '../src/hail-sync';
import { createLogger } from '../src/log';
import { processVisit } from '../src/resolution';
import { SITE_ID, uuidFrom } from './helpers';

const log = createLogger({ req_id: 'test' });
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 7, 17, 0, 0);
const esc = (s: string) => s.replace(/</g, '&lt;');

const SAMPLE = toLeadPayload({
  id: 'lead_1', site_id: SITE_ID, visitor_id: uuidFrom(1), identity_request_id: 'req_1',
  first_name: 'Maria', last_name: 'Garcia', address_line1: '412 Example Ln', address_line2: null,
  city: 'Plano', state: 'TX', zip: '75024', phone: '(972) 555-0142', email: 'maria.garcia@example.com',
  confidence: 0.84, lat: null, lng: null, linkedin_url: null, email_hash: null, extra: '{}', created_at: NOW,
});

const FOUND: HailFacts = { kind: 'found', inches: 1.75, miles: 1.2, at: NOW - 6 * HOUR, place: '2 mi NNE of Plano', others: 2, score: 88, fromHome: true, source: 'noaa' };

function card(hail?: HailFacts) {
  return { payload: SAMPLE, siteName: 'Test Roofing', pages: ['/'], connection: { city: 'Plano', region: 'TX' }, mock: false, hail, now: NOW };
}

describe('hail facts on the lead card', () => {
  it('leads with size, distance and age, and puts the hail in the subject', () => {
    expect(leadSubject(card(FOUND))).toBe('New lead: Maria Garcia, Plano · 1.75" hail 6 hours ago · Test Roofing');
    const html = leadHtml(card(FOUND));
    expect(html).toContain('Hail near this home');
    expect(html).toContain('1.75&quot; hail · 1.2 mi away · 6 hours ago');
    expect(html).toContain('reported 2 mi NNE of Plano');
    expect(html).toContain('National Weather Service storm report');
    expect(html).toContain('2 more reports within 5 mi in 6 months · Hail score 88/100');
    expect(leadText(card(FOUND))).toContain('Hail:       1.75" hail · 1.2 mi away · 6 hours ago');
  });

  it('gives no advice on when to call', () => {
    const all = leadHtml(card(FOUND)) + leadText(card(FOUND));
    expect(all).not.toMatch(/wait|too early|knock|call them/i);
  });

  it('drops the distance and says why when the house could not be mapped', () => {
    const html = leadHtml(card({ ...FOUND, fromHome: false }));
    expect(html).toContain('Hail near them');
    expect(html).not.toContain('mi away');
    expect(html).toContain("couldn&#39;t map the house");
  });

  it('says so when there is no hail, and leaves the subject alone', () => {
    const none: HailFacts = { kind: 'none', radiusMiles: 5, windowDays: 180, fromHome: true };
    expect(leadHtml(card(none))).toContain('No hail reported within 5 miles in the last 6 months.');
    expect(leadText(card(none))).toContain('Hail:       none reported within 5 mi in the last 6 months');
    expect(leadSubject(card(none))).toBe('New lead: Maria Garcia, Plano · Test Roofing');
  });

  it('says "no hail" was measured from where they were browsing when the house could not be mapped', () => {
    const none: HailFacts = { kind: 'none', radiusMiles: 5, windowDays: 180, fromHome: false };
    const html = leadHtml(card(none));
    expect(html).toContain('No hail reported within 5 miles in the last 6 months.');
    expect(html).toContain("couldn&#39;t map the house");
    expect(leadText(card(none))).toContain("            We couldn't map the house, so this is measured from where they were browsing.");
    expect(hailJson(none, NOW)).toEqual({ found: false, radius_mi: 5, window_days: 180, measured_from: 'visit', summary: 'No hail reported within 5 mi of where they were browsing in the last 6 months' });
    const home: HailFacts = { ...none, fromHome: true };
    expect(leadHtml(card(home)) + leadText(card(home))).not.toContain('map the house');
  });

  it('shows nothing when scoring did not run or there was no location', () => {
    expect(leadHtml(card())).not.toContain('Hail');
    expect(leadText(card({ kind: 'unknown' }))).not.toContain('Hail');
  });

  it('marks the last two weeks louder than older hail', () => {
    const fresh = hailHtml({ ...FOUND, at: NOW - 3 * DAY }, NOW, esc);
    const old = hailHtml({ ...FOUND, at: NOW - 90 * DAY }, NOW, esc);
    expect(fresh).toContain('#c2410c');
    expect(old).not.toContain('#c2410c');
    expect(old).toContain('90 days ago');
  });

  it('formats ages and NWS places plainly', () => {
    expect(agoLabel(NOW - 20 * 60 * 1000, NOW)).toBe('under an hour ago');
    expect(agoLabel(NOW - 1.5 * HOUR, NOW)).toBe('1 hour ago');
    expect(agoLabel(NOW - 47 * HOUR, NOW)).toBe('47 hours ago');
    expect(agoLabel(NOW - 9 * DAY, NOW)).toBe('9 days ago');
    expect(placeFrom('{"city":"2 NNE Plano"}')).toBe('2 mi NNE of Plano');
    expect(placeFrom('{"city":"Plano"}')).toBe('Plano');
    expect(placeFrom('{}')).toBeNull();
    expect(placeFrom('not json')).toBeNull();
  });

  it('builds facts from a score: the best event, the place, and the count of others', () => {
    const ev = (id: string, daysAgo: number, inches: number, lat: number): HailEventRow => ({
      id, source: 'noaa', external_id: id, event_at: NOW - daysAgo * DAY, lat, lng: -96.7, geom: null, max_hail_in: inches,
      severity: null, state: 'TX', county: 'Collin', zip: null, raw: JSON.stringify({ city: '1 N Plano' }), created_at: NOW,
    });
    const events = [ev('a', 2, 2, 33.03), ev('b', 100, 1, 33.04)];
    const result = scoreVisit({ visit: { lat: 33.02, lng: -96.7, postal: null }, lead: { lat: 33.02, lng: -96.7, zip: null }, events, now: NOW });
    const f = hailFacts(result, events);
    expect(f).toMatchObject({ kind: 'found', inches: 2, at: NOW - 2 * DAY, place: '1 mi N of Plano', others: 1, fromHome: true, source: 'noaa' });
  });
});

describe('hail sync', () => {
  it('deletes mock hail once a real source is on, so fake storms never reach a card', async () => {
    await syncHailEvents(env.DB, new MockHailSource(), HAIL_SYNC_BBOX, new Date(Date.now() - HAIL_SYNC_LOOKBACK_MS));
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM hail_events WHERE source = 'mock'").first<{ n: number }>();
    expect(before?.n).toBeGreaterThan(0);
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ features: [] }))) as typeof fetch;
    try {
      const r = await runHailSync({ DB: env.DB, HAIL_SOURCE: 'noaa' }, log, 3 * DAY);
      expect(r).toEqual({ source: 'noaa', events: 0, purged: before?.n });
    } finally {
      globalThis.fetch = orig;
    }
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM hail_events').first<{ n: number }>()).toEqual({ n: 0 });
  });

  it('asks for six months on the first run and when the table has rows only at 03:23 UTC', async () => {
    const env2 = { DB: env.DB, HAIL_SOURCE: 'noaa' };
    const noon = Date.UTC(2026, 9, 7, 12, 23);
    expect(await cronLookbackMs(env2, noon)).toBe(HAIL_SYNC_LOOKBACK_MS);
    await upsertHailEvents(env.DB, [{ source: 'noaa', external_id: 'x', event_at: noon, lat: 33, lng: -97, geom: null, max_hail_in: 1, severity: null, state: 'TX', county: null, zip: null, raw: '{}' }]);
    expect(await cronLookbackMs(env2, noon)).toBe(3 * DAY);
    expect(await cronLookbackMs(env2, Date.UTC(2026, 9, 8, 3, 23))).toBe(HAIL_SYNC_LOOKBACK_MS);
  });

  it('replaces NOAA rows stored under the old id (product id first) inside the window it just synced', async () => {
    const now = Date.now();
    const valid = `${new Date(now - DAY).toISOString().slice(0, 19)}Z`;
    const at = Date.parse(valid);
    const row = (externalId: string, eventAt: number) => ({
      source: 'noaa', external_id: externalId, event_at: eventAt, lat: 33.05, lng: -96.7, geom: null, max_hail_in: 1, severity: null, state: 'TX', county: 'Collin', zip: null, raw: '{}',
    });
    const outside = '202609010000-KFWD-NWUS54-LSRFWD:2026-09-01T00:00:00Z:33.05,-96.7';
    await upsertHailEvents(env.DB, [
      row(`202610070000-KFWD-NWUS54-LSRFWD:${valid}:33.05,-96.7`, at), // the original
      row(`202610070030-KFWD-NWUS54-LSRFWD:${valid}:33.05,-96.7`, at), // its correction, stored again
      row(`lsr:${valid}:33.06,-96.7`, at), // old id with no product
      row(outside, now - 30 * DAY), // old id, outside the 3 days asked for: left for the full sync
    ]);
    const ids = async () => (await env.DB.prepare('SELECT external_id AS id FROM hail_events ORDER BY event_at, external_id').all<{ id: string }>()).results.map((r) => r.id);
    const feature = {
      properties: { type: 'H', typetext: 'HAIL', magf: 1.75, magnitude: '1.75', valid, lat: 33.05, lon: -96.7, state: 'TX', county: 'Collin', city: '2 NNE Plano', wfo: 'FWD', product_id: '202610070030-KFWD-NWUS54-LSRFWD' },
    };
    const orig = globalThis.fetch;
    try {
      // An empty answer (a broken feed) deletes nothing.
      globalThis.fetch = (async () => new Response(JSON.stringify({ features: [] }))) as typeof fetch;
      expect(await runHailSync({ DB: env.DB, HAIL_SOURCE: 'noaa' }, log, 3 * DAY, now)).toEqual({ source: 'noaa', events: 0, purged: 0 });
      expect(await ids()).toHaveLength(4);
      globalThis.fetch = (async () => new Response(JSON.stringify({ features: [feature] }))) as typeof fetch;
      expect(await runHailSync({ DB: env.DB, HAIL_SOURCE: 'noaa' }, log, 3 * DAY, now)).toEqual({ source: 'noaa', events: 1, purged: 3 });
    } finally {
      globalThis.fetch = orig;
    }
    const left = await ids();
    expect(left).toHaveLength(2);
    expect(left[0]).toBe(outside);
    expect(left[1]?.startsWith(NOAA_ID_PREFIX)).toBe(true);
  });

  it('writes a big spring of reports without hitting the per-run query limit', async () => {
    const rows = Array.from({ length: 1500 }, (_, i) => ({
      source: 'noaa', external_id: `r${i}`, event_at: Date.now() - i * HOUR, lat: 32 + i / 1000, lng: -97, geom: null, max_hail_in: 1,
      severity: 'moderate' as const, state: 'TX', county: null, zip: null, raw: '{}',
    }));
    expect(await upsertHailEvents(env.DB, rows)).toBe(1500);
    expect(await upsertHailEvents(env.DB, rows)).toBe(1500); // re-sync updates, never duplicates
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM hail_events').first<{ n: number }>()).toEqual({ n: 1500 });
  });
});

describe('hail on a real resolution', () => {
  const orig = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = orig;
  });

  function plano(visitorId: string): NewVisit {
    return {
      id: crypto.randomUUID(), site_id: SITE_ID, visitor_id: visitorId, session_id: 'sess_abcdefgh', url: 'http://localhost/roof-repair', path: '/roof-repair',
      referrer: null, title: null, ip_hash: 'h', ip_raw: null, country: 'US', region: 'TX', city: 'Plano', postal: '75024', asn: null, colo: null,
      lat: 33.0603, lng: -96.7489, user_agent: 'Mozilla/5.0', device: '{}', screen: '{}', timezone: null, language: null, bot_score: null,
      occurred_at: Date.now(), created_at: Date.now(), gpc: 0, asn_org: 'AT&T', asn_class: 'residential',
    };
  }

  async function resolvableVisitorId(): Promise<string> {
    const p = new MockProvider();
    for (let i = 0; i < 500; i++) {
      const vid = uuidFrom(i);
      const r = await p.resolve({ visitor_id: vid, visit_id: 'x', site_id: SITE_ID, ip: null, ip_hash: 'h', user_agent: null, geo: { country: null, region: null, city: null, postal: null, lat: null, lng: null, asn: null }, occurred_at: 0, created_at: 0 });
      if (r.status === 'resolved') return vid;
    }
    throw new Error('mock never resolved');
  }

  /** Stub the network: the Census geocoder answers with a point next to the mock Plano storm; Resend records the email. */
  function stubNetwork(geocodes: boolean): Array<{ subject: string; html: string }> {
    const sent: Array<{ subject: string; html: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://geocoding.geo.census.gov/')) {
        const matches = geocodes ? [{ coordinates: { x: -96.7489, y: 33.0503 } }] : [];
        return new Response(JSON.stringify({ result: { addressMatches: matches } }));
      }
      if (url === 'https://api.resend.com/emails') {
        sent.push(JSON.parse(String(init?.body)) as { subject: string; html: string });
        return new Response(JSON.stringify({ id: 'r1' }));
      }
      return new Response('unexpected', { status: 500 });
    }) as typeof fetch;
    return sent;
  }

  async function run(geocodes: boolean) {
    await syncHailEvents(env.DB, new MockHailSource(), HAIL_SYNC_BBOX, new Date(Date.now() - HAIL_SYNC_LOOKBACK_MS));
    await updateSiteDelivery(env.DB, SITE_ID, { leadEmail: 'owner@example.com', webhookUrl: null, webhookKind: null });
    const sent = stubNetwork(geocodes);
    const v = plano(await resolvableVisitorId());
    await insertVisit(env.DB, v);
    const r = await processVisit({ ...env, EMAIL_API_KEY: 'k', GEOCODER: 'census' }, v.id, log, new MockProvider());
    expect(r.outcome).toBe('resolved');
    return { sent, leadId: r.leadId as string };
  }

  it('maps the house, scores before sending, and puts the hail on the card', async () => {
    const { sent, leadId } = await run(true);
    const lead = await env.DB.prepare('SELECT * FROM leads WHERE id = ?').bind(leadId).first<LeadRow>();
    expect(lead?.lat).toBeCloseTo(33.0503);
    expect(lead?.lng).toBeCloseTo(-96.7489);
    const score = await env.DB.prepare('SELECT * FROM lead_scores WHERE lead_id = ?').bind(leadId).first<LeadScoreRow>();
    expect(score?.score).toBeGreaterThan(0);
    expect(JSON.parse(score?.components ?? '{}').location.source).toBe('lead');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toContain('1.75" hail 2 days ago');
    expect(sent[0]?.html).toContain('Hail near this home');
    expect(sent[0]?.html).toContain('0.7 mi away');
  });

  it('shows the hail on the dashboard, sorts by it, and puts it in the leads feed', async () => {
    await run(true);
    const q = `key=test-admin-token&site=${SITE_ID}`;
    const page = await (await app.fetch(new Request(`http://localhost/app?${q}`), env)).text();
    expect(page).toContain('<th>Hail</th>');
    expect(page).toContain('2 days ago');
    expect(page).toContain('Most hail first</a>');
    const sorted = await (await app.fetch(new Request(`http://localhost/app?${q}&sort=hail`), env)).text();
    expect(sorted).toContain('<strong>Most hail first</strong>');
    const feed = await (await app.fetch(new Request(`http://localhost/app/leads.json?${q}`), env)).json<{ leads: Array<{ hail: Record<string, unknown> | null }> }>();
    expect(feed.leads[0]?.hail).toMatchObject({ found: true, max_hail_in: 1.75, days_ago: 2, measured_from: 'home' });
  });

  it('falls back to the visit location when the address does not map', async () => {
    const { sent, leadId } = await run(false);
    const lead = await env.DB.prepare('SELECT * FROM leads WHERE id = ?').bind(leadId).first<LeadRow>();
    expect(lead?.lat).toBeNull();
    expect(sent[0]?.html).toContain('Hail near them');
    expect(sent[0]?.html).not.toContain('mi away');
  });
});

describe('hail in webhooks', () => {
  const CTX = { siteName: 'Test Roofing', pages: ['/roof-repair'], mock: false, now: NOW };

  it('json carries a hail object with facts and a summary', () => {
    const b = webhookBody('json', SAMPLE, { ...CTX, hail: FOUND }) as { hail: Record<string, unknown> };
    expect(b.hail).toMatchObject({
      found: true, max_hail_in: 1.75, distance_mi: 1.2, measured_from: 'home', event_at: new Date(NOW - 6 * HOUR).toISOString(),
      days_ago: 0, place: '2 mi NNE of Plano', other_reports: 2, score: 88, source: 'National Weather Service storm report',
      summary: '1.75" hail · 1.2 mi away · 6 hours ago',
    });
  });

  it('json says found: false with no hail, null when scoring did not run, and hides miles from the visit location', () => {
    const none = webhookBody('json', SAMPLE, { ...CTX, hail: { kind: 'none', radiusMiles: 5, windowDays: 180, fromHome: true } }) as { hail: Record<string, unknown> };
    expect(none.hail).toEqual({ found: false, radius_mi: 5, window_days: 180, measured_from: 'home', summary: 'No hail reported within 5 mi in the last 6 months' });
    expect((webhookBody('json', SAMPLE, CTX) as { hail: unknown }).hail).toBeNull();
    const visit = webhookBody('json', SAMPLE, { ...CTX, hail: { ...FOUND, fromHome: false } }) as { hail: Record<string, unknown> };
    expect(visit.hail).toMatchObject({ distance_mi: null, measured_from: 'visit', summary: '1.75" hail · 6 hours ago' });
  });

  it('slack gets a hail line; GoHighLevel gets a tag and a field', () => {
    expect((webhookBody('slack', SAMPLE, { ...CTX, hail: FOUND }) as { text: string }).text).toContain(':cloud_with_lightning: 1.75" hail · 1.2 mi away · 6 hours ago');
    expect((webhookBody('slack', SAMPLE, CTX) as { text: string }).text).not.toContain('cloud_with_lightning');
    const ghl = webhookBody('ghl', SAMPLE, { ...CTX, hail: FOUND }) as { tags: string[]; customField: Record<string, string> };
    expect(ghl.tags).toContain('yardsign-hail');
    expect(ghl.customField.hail).toBe('1.75" hail · 1.2 mi away · 6 hours ago');
    const noHail = webhookBody('ghl', SAMPLE, { ...CTX, hail: { kind: 'none', radiusMiles: 5, windowDays: 180, fromHome: true } }) as { tags: string[] };
    expect(noHail.tags).not.toContain('yardsign-hail');
  });
});

describe('hail from a stored score', () => {
  const comps = (events: unknown[], source = 'lead') => JSON.stringify({ location: { lat: 33, lng: -97, source }, radius_miles: 5, window_days: 180, events });

  it('rebuilds the report time from when it was scored', () => {
    const h = hailFactsFromScore({ score: 74, hail_days_since: 9, hail_max_in: 1.75, hail_distance_mi: 1.2, scored_at: NOW, components: comps([{ source: 'noaa', distance_mi: 1.2 }, {}]) });
    expect(h).toEqual({ kind: 'found', inches: 1.75, miles: 1.2, at: NOW - 9 * DAY, place: null, others: 1, score: 74, fromHome: true, source: 'noaa' });
    expect(hailJson(h, NOW + DAY)?.days_ago).toBe(10); // ages as time passes
  });

  it('reads no events as none, no location or bad JSON as unknown', () => {
    expect(hailFactsFromScore({ score: 0, hail_days_since: null, hail_max_in: null, hail_distance_mi: null, scored_at: NOW, components: comps([], 'visit') })).toEqual({ kind: 'none', radiusMiles: 5, windowDays: 180, fromHome: false });
    expect(hailFactsFromScore({ score: 0, hail_days_since: null, hail_max_in: null, hail_distance_mi: null, scored_at: NOW, components: '{"location":null}' }).kind).toBe('unknown');
    expect(hailFactsFromScore({ score: 0, hail_days_since: null, hail_max_in: null, hail_distance_mi: null, scored_at: NOW, components: 'nope' }).kind).toBe('unknown');
  });

  it('sorts most hail first, then newest', () => {
    const v = (id: string, created: number, hail?: HailFacts): LeadView => ({ lead: { id, created_at: created } as LeadRow, pages: [], delivery: null, hail });
    const views = [v('new-none', 5, { kind: 'none', radiusMiles: 5, windowDays: 180, fromHome: true }), v('old-big', 1, { ...FOUND, score: 90 }), v('mid-small', 3, { ...FOUND, score: 40 }), v('never', 4)];
    expect(sortLeads(views, 'hail').map((x) => x.lead.id)).toEqual(['old-big', 'mid-small', 'new-none', 'never']);
    expect(sortLeads(views, 'newest').map((x) => x.lead.id)).toEqual(['new-none', 'old-big', 'mid-small', 'never']);
  });
});

describe('"no hail" only while the NOAA feed is fresh', () => {
  /** A report in San Antonio: in the feed, but far from Plano. */
  const farAway = (id: string, at: number) => ({
    source: 'noaa', external_id: id, event_at: at, lat: 29.42, lng: -98.49, geom: null, max_hail_in: 1, severity: null, state: 'TX', county: 'Bexar', zip: null, raw: '{}',
  });

  async function planoVisit(): Promise<VisitRow> {
    const t = Date.now();
    const v: NewVisit = {
      id: crypto.randomUUID(), site_id: SITE_ID, visitor_id: uuidFrom(77), session_id: 'sess_abcdefgh', url: 'http://localhost/', path: '/',
      referrer: null, title: null, ip_hash: 'h', ip_raw: null, country: 'US', region: 'TX', city: 'Plano', postal: '75024', asn: null, colo: null,
      lat: 33.0603, lng: -96.7489, user_agent: 'Mozilla/5.0', device: '{}', screen: '{}', timezone: null, language: null, bot_score: null,
      occurred_at: t, created_at: t, gpc: 0, asn_org: null, asn_class: 'residential',
    };
    await insertVisit(env.DB, v);
    return { ...v, resolve_attempted_at: null, time_on_page_ms: null, skip_reason: null };
  }

  it('reads only the configured source', async () => {
    const now = Date.now();
    const visit = await planoVisit();
    await upsertHailEvents(env.DB, [{ ...farAway('near', now - 5 * DAY), lat: 33.06, lng: -96.75 }]);
    const r = await scoreAndStore(env.DB, visit, null, now, 'noaa');
    expect(hailFacts(r.result, r.events).kind).toBe('found');
    const mock = await scoreAndStore(env.DB, visit, null, now, 'mock');
    expect(hailFacts(mock.result, mock.events).kind).toBe('none');
  });
});
