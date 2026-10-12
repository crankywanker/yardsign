import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearExpiredRawIps, getVisit, type DeliveryRow, type IdentityRequestRow, type LeadRow, type LeadScoreRow, type VisitRow } from '@yardsign/db';
import { MockProvider } from '@yardsign/identity';
import { MockHailSource, syncHailEvents } from '@yardsign/scoring';
import { HAIL_SYNC_BBOX, HAIL_SYNC_LOOKBACK_MS } from '../src/hail-sync';
import { sourceLabel } from '../src/admin-stats';
import { app } from '../src/app';
import { createLogger } from '../src/log';
import { pollUnresolvedVisits } from '../src/resolution';
import { HUMAN_UA, ORIGIN, PLANO_CF, SITE_ID, SITE_KEY, TestExecutionContext, adminHeaders, pixelRequest, postCollect, uuidFrom, viewPayload } from './helpers';

const log = createLogger({ req_id: 'test' });

async function count(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

async function classifyVisitor(status: 'resolved' | 'no_match'): Promise<string> {
  const p = new MockProvider();
  for (let i = 0; i < 500; i++) {
    const vid = uuidFrom(i);
    const r = await p.resolve({ visitor_id: vid, visit_id: 'x', site_id: SITE_ID, ip: null, ip_hash: 'h', user_agent: null, geo: { country: null, region: null, city: null, postal: null, lat: null, lng: null, asn: null }, occurred_at: 0, created_at: 0 });
    if (r.status === status) return vid;
  }
  throw new Error(`no ${status} visitor found`);
}

describe('GET /health', () => {
  it('returns the build sha and resolution mode', async () => {
    const res = await app.fetch(new Request('http://localhost/health'), env);
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; sha: string; resolution: string }>();
    expect(body.ok).toBe(true);
    expect(body.sha).toBeTruthy();
    expect(body.resolution).toBe('poll');
  });
});

describe('GET /', () => {
  it('serves the landing page with the demo card and the founder site pixel', async () => {
    const res = await app.fetch(new Request('http://localhost/', { cf: PLANO_CF } as RequestInit), env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Know who drove past.');
    expect(html).toContain('<script async src="/p/TRYYARDSIGN.js"></script>');
    expect(html).toContain('Plano');
    expect(html).toContain('We would try to identify this visit');
    expect(html).not.toMatch(/codename/i);
    expect(html).not.toContain('Teresa'); // never a visitor's name on a public page
  });
  it('serves the pixel for the founder site key', async () => {
    const res = await app.fetch(new Request('http://localhost/p/TRYYARDSIGN.js'), env);
    expect(res.status).toBe(200);
  });
});

describe('GET /p/:siteKey.js', () => {
  it('serves the pixel with the site key and collect URL baked in', async () => {
    const res = await app.fetch(new Request('http://localhost:8787/p/TESTKEY.js'), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
    expect(res.headers.get('cache-control')).toMatch(/^private/);
    const js = await res.text();
    expect(js).toContain('"TESTKEY"');
    expect(js).toContain('"http://localhost:8787/collect"');
    expect(js).not.toContain('__YS_');
  });
  it('uses PUBLIC_BASE_URL when set', async () => {
    const res = await app.fetch(new Request('http://localhost:8787/p/TESTKEY.js'), { ...env, PUBLIC_BASE_URL: 'https://cdn.tryyardsign.com/' });
    expect(await res.text()).toContain('"https://cdn.tryyardsign.com/collect"');
  });
  it('honors ETag', async () => {
    const first = await app.fetch(new Request('http://localhost:8787/p/TESTKEY.js'), env);
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();
    const second = await app.fetch(new Request('http://localhost:8787/p/TESTKEY.js', { headers: { 'if-none-match': etag! } }), env);
    expect(second.status).toBe(304);
  });
  it('404s for unknown, malformed and inactive sites', async () => {
    expect((await app.fetch(new Request('http://localhost/p/NOPE.js'), env)).status).toBe(404);
    expect((await app.fetch(new Request('http://localhost/p/TESTKEY'), env)).status).toBe(404);
    expect((await app.fetch(new Request('http://localhost/p/bad%20key.js'), env)).status).toBe(404);
    await env.DB.prepare('UPDATE sites SET active = 0 WHERE id = ?').bind(SITE_ID).run();
    expect((await app.fetch(new Request('http://localhost/p/TESTKEY.js'), env)).status).toBe(404);
  });
});

describe('POST /collect', () => {
  it('stores a visit with server-side geo and hashed ip', async () => {
    const payload = viewPayload();
    const { res, ctx } = await postCollect(payload);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    await ctx.settle();

    const v = await getVisit(env.DB, payload.id as string);
    expect(v).not.toBeNull();
    expect(v?.site_id).toBe(SITE_ID);
    expect(v?.path).toBe('/roof-repair');
    expect(v?.country).toBe('US');
    expect(v?.postal).toBe('75024');
    expect(v?.lat).toBeCloseTo(33.0198);
    expect(v?.ip_raw).toBe('203.0.113.10');
    expect(v?.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(v?.bot_score).toBeNull();
    expect(JSON.parse(v?.device ?? '{}').browser).toBe('Chrome');
    expect(v?.resolve_attempted_at).toBeNull();

    const visitor = await env.DB.prepare('SELECT * FROM visitors WHERE site_id = ? AND id = ?').bind(SITE_ID, payload.vid).first<{ visit_count: number }>();
    expect(visitor?.visit_count).toBe(1);

    // ZIP-level score row is written in the background, even with no hail events loaded.
    const score = await env.DB.prepare('SELECT * FROM lead_scores WHERE visit_id = ?').bind(payload.id).first<LeadScoreRow>();
    expect(score?.lead_id).toBeNull();
    expect(score?.score).toBe(0);
  });

  it('bumps visit_count on a return visit', async () => {
    await (await postCollect(viewPayload({ vid: uuidFrom(9) }))).ctx.settle();
    await (await postCollect(viewPayload({ vid: uuidFrom(9) }))).ctx.settle();
    const visitor = await env.DB.prepare('SELECT visit_count FROM visitors WHERE id = ?').bind(uuidFrom(9)).first<{ visit_count: number }>();
    expect(visitor?.visit_count).toBe(2);
  });

  it('stores nothing for geo-blocked countries', async () => {
    const { res } = await postCollect(viewPayload(), { cf: { ...PLANO_CF, country: 'DE' } });
    expect(res.status).toBe(204);
    expect(await count('visits')).toBe(0);
    const uk = await postCollect(viewPayload(), { cf: { ...PLANO_CF, country: 'GB' } });
    expect(uk.res.status).toBe(204);
    expect(await count('visits')).toBe(0);
  });

  it('drops bots by user agent and by bot score', async () => {
    await postCollect(viewPayload(), { ua: 'Googlebot/2.1 (+http://www.google.com/bot.html)' });
    await postCollect(viewPayload(), { cf: { ...PLANO_CF, botManagement: { score: 5 } } });
    await postCollect(viewPayload(), { ua: null });
    expect(await count('visits')).toBe(0);
  });

  it('stores the bot score when the plan provides one', async () => {
    const p = viewPayload();
    await (await postCollect(p, { cf: { ...PLANO_CF, botManagement: { score: 92 } } })).ctx.settle();
    expect((await getVisit(env.DB, p.id as string))?.bot_score).toBe(92);
  });

  it('rejects origins that are not registered', async () => {
    expect((await postCollect(viewPayload(), { origin: 'https://evil.example.net' })).res.status).toBe(403);
    expect((await postCollect(viewPayload(), { origin: null })).res.status).toBe(403);
    expect(await count('visits')).toBe(0);
  });

  it('ignores unknown site keys and bad payloads quietly', async () => {
    expect((await postCollect(viewPayload({ k: 'NOTASITE' }))).res.status).toBe(204);
    expect((await postCollect(null, { rawBody: 'not json' })).res.status).toBe(204);
    expect((await postCollect(viewPayload({ e: 'keystrokes' }))).res.status).toBe(204);
    expect(await count('visits')).toBe(0);
  });

  it('rejects payloads over 8 KB', async () => {
    const big = viewPayload({ t: 'x'.repeat(9000) });
    expect((await postCollect(big)).res.status).toBe(413);
    expect((await postCollect(viewPayload(), { contentLength: '9001' })).res.status).toBe(413);
  });

  it('rate limits per ip hash', async () => {
    const envOverride = { RATE_LIMIT_IP_PER_MIN: '2' };
    expect((await postCollect(viewPayload(), { envOverride })).res.status).toBe(204);
    expect((await postCollect(viewPayload(), { envOverride })).res.status).toBe(204);
    const third = await postCollect(viewPayload(), { envOverride });
    expect(third.res.status).toBe(429);
    expect(third.res.headers.get('retry-after')).toBe('60');
    // A different IP is a different bucket.
    expect((await postCollect(viewPayload(), { envOverride, ip: '203.0.113.99' })).res.status).toBe(204);
  });

  it('fails closed without IP_SALT', async () => {
    const { res } = await postCollect(viewPayload(), { envOverride: { IP_SALT: undefined } });
    expect(res.status).toBe(500);
    expect(await count('visits')).toBe(0);
  });

  it('updates time on page from the unload beacon, scoped to the visitor', async () => {
    const p = viewPayload();
    await (await postCollect(p)).ctx.settle();
    const unload = { k: SITE_KEY, e: 'unload', id: p.id, vid: p.vid, sid: p.sid, top: 42000, ts: Date.now() };
    expect((await postCollect(unload)).res.status).toBe(204);
    expect((await getVisit(env.DB, p.id as string))?.time_on_page_ms).toBe(42000);
    // Another visitor cannot touch it.
    await postCollect({ ...unload, vid: uuidFrom(77), top: 1 });
    expect((await getVisit(env.DB, p.id as string))?.time_on_page_ms).toBe(42000);
    expect(await count('visits')).toBe(1);
  });

  it('nulls raw ips after 72 hours', async () => {
    const p = viewPayload();
    await (await postCollect(p)).ctx.settle();
    expect(await clearExpiredRawIps(env.DB, 72 * 3600 * 1000, Date.now())).toBe(0);
    expect(await clearExpiredRawIps(env.DB, 72 * 3600 * 1000, Date.now() + 73 * 3600 * 1000)).toBe(1);
    expect((await getVisit(env.DB, p.id as string))?.ip_raw).toBeNull();
  });
});

describe('hail scoring on collect', () => {
  beforeEach(async () => {
    await syncHailEvents(env.DB, new MockHailSource(), HAIL_SYNC_BBOX, new Date(Date.now() - HAIL_SYNC_LOOKBACK_MS));
  });

  it('scores a Plano visit against nearby mock hail', async () => {
    const p = viewPayload();
    await (await postCollect(p)).ctx.settle();
    const score = await env.DB.prepare('SELECT * FROM lead_scores WHERE visit_id = ?').bind(p.id).first<LeadScoreRow>();
    expect(score?.score).toBeGreaterThan(0);
    expect(score?.lead_id).toBeNull();
    const components = JSON.parse(score?.components ?? '{}') as { level: string; events: unknown[] };
    expect(components.level).toBe('zip');
    expect(components.events.length).toBeGreaterThan(0);
  });

  it('scores 0 far from any event', async () => {
    const p = viewPayload();
    await (await postCollect(p, { cf: { ...PLANO_CF, city: 'El Paso', postalCode: '79901', latitude: '31.7587', longitude: '-106.4869' } })).ctx.settle();
    const score = await env.DB.prepare('SELECT * FROM lead_scores WHERE visit_id = ?').bind(p.id).first<LeadScoreRow>();
    expect(score?.score).toBe(0);
  });
});

describe('end to end: collect, resolve, lead, deliver, score', () => {
  it('creates a lead for a resolvable visitor and not for a no-match one', async () => {
    await syncHailEvents(env.DB, new MockHailSource(), HAIL_SYNC_BBOX, new Date(Date.now() - HAIL_SYNC_LOOKBACK_MS));
    const hit = viewPayload({ vid: await classifyVisitor('resolved') });
    const miss = viewPayload({ vid: await classifyVisitor('no_match') });
    const boom = viewPayload({ vid: uuidFrom(5, 'ff') });
    for (const p of [hit, miss, boom]) {
      const { res, ctx } = await postCollect(p);
      expect(res.status).toBe(204);
      await ctx.settle();
    }
    expect(await count('visits')).toBe(3);
    expect(await count('leads')).toBe(0);

    // Poll mode: this is what the cron runs.
    expect(await pollUnresolvedVisits(env, log)).toBe(3);
    expect(await pollUnresolvedVisits(env, log)).toBe(0);

    const leads = (await env.DB.prepare('SELECT * FROM leads').all<LeadRow>()).results;
    expect(leads).toHaveLength(1);
    const lead = leads[0]!;
    expect(lead.visitor_id).toBe(hit.vid);
    expect(lead.state).toBe('TX');
    expect(lead.phone).toMatch(/555-01\d\d/);

    const reqs = (await env.DB.prepare('SELECT * FROM identity_requests ORDER BY created_at').all<IdentityRequestRow>()).results;
    expect(reqs.map((r) => r.status).sort()).toEqual(['error', 'no_match', 'resolved']);
    const resolved = reqs.find((r) => r.status === 'resolved')!;
    expect(resolved.cost_cents).toBe(25);
    expect(resolved.request_payload).not.toContain('203.0.113.10'); // raw ip is never copied into the request log
    const errored = reqs.find((r) => r.status === 'error')!;
    expect(errored.response_payload).toContain('simulated');

    const deliveries = (await env.DB.prepare('SELECT * FROM deliveries').all<DeliveryRow>()).results;
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.channel).toBe('log');
    expect(deliveries[0]?.status).toBe('delivered');
    expect(deliveries[0]?.lead_id).toBe(lead.id);

    const scores = (await env.DB.prepare('SELECT * FROM lead_scores WHERE visit_id = ? ORDER BY scored_at').bind(hit.id).all<LeadScoreRow>()).results;
    expect(scores).toHaveLength(2);
    expect(scores[0]?.lead_id).toBeNull();
    expect(scores[1]?.lead_id).toBe(lead.id);
    expect(JSON.parse(scores[1]?.components ?? '{}').level).toBe('address');

    const visits = (await env.DB.prepare('SELECT * FROM visits').all<VisitRow>()).results;
    for (const v of visits) expect(v.resolve_attempted_at).not.toBeNull();
  });
});

describe('GET /api/admin/visits', () => {
  it('requires the bearer token', async () => {
    expect((await app.fetch(new Request('http://localhost/api/admin/visits?siteKey=TESTKEY'), env)).status).toBe(401);
    expect((await app.fetch(new Request('http://localhost/api/admin/visits?siteKey=TESTKEY', { headers: { authorization: 'Bearer wrong' } }), env)).status).toBe(401);
  });

  it('lists recent visits with the lead joined and no raw ip', async () => {
    const hit = viewPayload({ vid: await classifyVisitor('resolved') });
    await (await postCollect(hit)).ctx.settle();
    await pollUnresolvedVisits(env, log);

    const res = await app.fetch(new Request('http://localhost/api/admin/visits?siteKey=TESTKEY&limit=10', { headers: adminHeaders() }), env);
    expect(res.status).toBe(200);
    const body = await res.json<{ count: number; visits: Array<{ id: string; ip_raw: string | null; identity_status: string; lead: { first_name: string } | null; score: { score: number } | null }> }>();
    expect(body.count).toBe(1);
    const v = body.visits[0]!;
    expect(v.id).toBe(hit.id);
    expect(v.ip_raw).toBeNull();
    expect(v.identity_status).toBe('resolved');
    expect(v.lead?.first_name).toBeTruthy();
    expect(v.score).not.toBeNull();
  });

  it('validates the site key', async () => {
    expect((await app.fetch(new Request('http://localhost/api/admin/visits', { headers: adminHeaders() }), env)).status).toBe(400);
    expect((await app.fetch(new Request('http://localhost/api/admin/visits?siteKey=NOPE', { headers: adminHeaders() }), env)).status).toBe(404);
  });
});

describe('Delivr pixel per site', () => {
  const PIXEL = '11111111-2222-3333-4444-555555555555';
  const setPixel = (pixel_id: string | null) =>
    app.request(`/api/admin/sites/${SITE_KEY}/delivr`, { method: 'PUT', headers: { ...adminHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ pixel_id }) }, env);

  it('the served pixel loads the partner script only when the site has a pixel id', async () => {
    // The partner URL prefix is always in the source; the pixel id is the switch. Empty id = never loaded.
    let js = await (await app.fetch(pixelRequest('TESTKEY'), env)).text();
    expect(js).not.toContain(PIXEL);
    expect(js).not.toContain('__YS_');

    const set = await setPixel(PIXEL);
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({ site_key: SITE_KEY, delivr_pixel_id: PIXEL });
    const res = await app.fetch(pixelRequest('TESTKEY'), env);
    js = await res.text();
    // Minified as 'https://cdn.sitelytics.tech/pixels/' + id + '/p.js', so check the parts.
    expect(js).toContain('cdn.sitelytics.tech/pixels/');
    expect(js).toContain(`"${PIXEL}"`);
    expect(js).toContain('ys_vid');
    expect(js).toContain('globalPrivacyControl');
    expect(res.headers.get('etag')).toContain(PIXEL.slice(0, 8));

    const cleared = await setPixel(null);
    expect(await cleared.json()).toEqual({ site_key: SITE_KEY, delivr_pixel_id: null });
    js = await (await app.fetch(pixelRequest('TESTKEY'), env)).text();
    expect(js).not.toContain(PIXEL);
  });

  it('rejects a bad pixel id and an unknown site', async () => {
    expect((await setPixel('no spaces!')).status).toBe(400);
    const res = await app.request('/api/admin/sites/NOPE/delivr', { method: 'PUT', headers: { ...adminHeaders(), 'content-type': 'application/json' }, body: '{}' }, env);
    expect(res.status).toBe(404);
  });

  it('leaves the partner id out when the page that loaded the tag is not on the site', async () => {
    await setPixel(PIXEL);
    const from = async (referer?: string) => (await app.fetch(pixelRequest('TESTKEY', { headers: referer ? { referer } : {} }), env)).text();
    expect(await from()).toContain(`"${PIXEL}"`); // no Referer: as before
    expect(await from('http://localhost:3000/roof-repair')).toContain(`"${PIXEL}"`);
    expect(await from('https://copycat.example.com/')).not.toContain(PIXEL);
    expect(await from('not a url')).not.toContain(PIXEL);
  });
});

describe('a cancelled account', () => {
  it('gets no pixel and no stored visits', async () => {
    await env.DB.prepare("UPDATE accounts SET status = 'suspended' WHERE id = 'acct_test'").run();
    const pixel = await app.fetch(pixelRequest(SITE_KEY), env);
    expect(pixel.status).toBe(404);
    expect(await pixel.text()).not.toContain('sitelytics');
    const { res } = await postCollect(viewPayload());
    expect(res.status).toBe(204);
    expect(await count('visits')).toBe(0);
    expect(await count('rate_limits')).toBe(0);
  });
});

describe('collect: rate limits', () => {
  it('a sender over its own limit does not use up the site limit', async () => {
    const envOverride = { RATE_LIMIT_IP_PER_MIN: '2', RATE_LIMIT_SITE_PER_MIN: '3' };
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await postCollect(viewPayload(), { envOverride, ip: '198.51.100.1' })).res.status);
    expect(statuses).toEqual([204, 204, 429, 429, 429, 429]);
    // Only the two allowed requests counted toward the site, so a real visitor still gets in.
    expect((await postCollect(viewPayload(), { envOverride, ip: '198.51.100.2' })).res.status).toBe(204);
    expect((await postCollect(viewPayload(), { envOverride, ip: '198.51.100.3' })).res.status).toBe(429); // the site's 4th
  });

  it('counts IPv6 per /64, so rotating addresses in one network share a limit', async () => {
    const envOverride = { RATE_LIMIT_IP_PER_MIN: '2' };
    expect((await postCollect(viewPayload(), { envOverride, ip: '2001:db8:1:2::a' })).res.status).toBe(204);
    expect((await postCollect(viewPayload(), { envOverride, ip: '2001:db8:1:2:aaaa:bbbb:cccc:dddd' })).res.status).toBe(204);
    expect((await postCollect(viewPayload(), { envOverride, ip: '2001:0db8:0001:0002::ffff' })).res.status).toBe(429);
    expect((await postCollect(viewPayload(), { envOverride, ip: '2001:db8:1:3::a' })).res.status).toBe(204); // another /64
    // The stored hash is still the full address.
    const hashes = (await env.DB.prepare('SELECT DISTINCT ip_hash FROM visits').all<{ ip_hash: string }>()).results;
    expect(hashes).toHaveLength(3);
  });
});

describe('collect: Origin null', () => {
  it('checks the page URL instead when a strict Referrer-Policy makes the browser send Origin: null', async () => {
    const ok = await postCollect(viewPayload(), { origin: 'null' });
    expect(ok.res.status).toBe(204);
    expect(ok.res.headers.get('access-control-allow-origin')).toBeNull();
    expect(await count('visits')).toBe(1);
    expect((await postCollect(viewPayload({ u: 'https://evil.example.net/roof' }), { origin: 'null' })).res.status).toBe(403);
    // An unload beacon has no page URL to check.
    expect((await postCollect({ k: SITE_KEY, e: 'unload', id: uuidFrom(5), vid: uuidFrom(1), sid: 'abcdefgh12345678', top: 1000, ts: Date.now() }, { origin: 'null' })).res.status).toBe(403);
    // A missing or malformed Origin is still refused.
    expect((await postCollect(viewPayload(), { origin: null })).res.status).toBe(403);
    expect((await postCollect(viewPayload(), { origin: 'nul' })).res.status).toBe(403);
    expect(await count('visits')).toBe(1);
  });
});

describe('collect: what is stored', () => {
  it('keeps only campaign tags on the page URL and the origin and path of the referrer', async () => {
    const p = viewPayload({
      u: 'http://localhost:3000/roof-repair?email=pat%40example.com&utm_source=facebook&token=abc&gclid=G1&utm_medium=paid_social#access_token=xyz',
      r: 'https://user:pw@www.google.com/search?q=pat+doe+roof#frag',
    });
    await (await postCollect(p)).ctx.settle();
    const v = await getVisit(env.DB, p.id as string);
    expect(v?.url).toBe('http://localhost:3000/roof-repair?utm_source=facebook&gclid=G1&utm_medium=paid_social');
    expect(v?.referrer).toBe('https://www.google.com/search');
    expect(v?.path).toBe('/roof-repair');
    // The /admin "Source" breakdown still reads both.
    expect(sourceLabel(v?.url ?? null, v?.referrer ?? null)).toBe('facebook · paid_social');
    const q = viewPayload({ u: 'http://localhost:3000/?fbclid=F&name=Pat', r: 'https://www.facebook.com/' });
    await (await postCollect(q)).ctx.settle();
    const w = await getVisit(env.DB, q.id as string);
    expect(w?.url).toBe('http://localhost:3000/?fbclid=F');
    expect(sourceLabel(w?.url ?? null, w?.referrer ?? null)).toBe('No tag, from facebook.com');
  });

  it('uses the server clock when the browser clock is more than 10 minutes off', async () => {
    const fast = viewPayload({ ts: Date.now() + 60 * 60 * 1000 });
    const close = viewPayload({ ts: Date.now() - 5 * 60 * 1000 });
    for (const p of [fast, close]) await (await postCollect(p)).ctx.settle();
    const f = await getVisit(env.DB, fast.id as string);
    expect(f?.occurred_at).toBe(f?.created_at);
    const c = await getVisit(env.DB, close.id as string);
    expect(c?.occurred_at).toBe(close.ts);
  });

  it('matches an unload beacon to its view whatever the case of the ids', async () => {
    const id = 'ABCDEF01-2345-4678-89AB-CDEF01234567';
    const vid = uuidFrom(31).toUpperCase();
    await (await postCollect(viewPayload({ id, vid }))).ctx.settle();
    await postCollect({ k: SITE_KEY, e: 'unload', id, vid, sid: 'abcdefgh12345678', top: 15000, ts: Date.now() });
    expect((await getVisit(env.DB, id.toLowerCase()))?.time_on_page_ms).toBe(15000);
  });

  it('stops reading a body with no Content-Length once it passes 8 KB', async () => {
    const send = (body: ReadableStream<Uint8Array>) => {
      const cf = PLANO_CF as unknown as RequestInitCfProperties;
      const req = new Request('http://localhost:8787/collect', { method: 'POST', headers: { origin: ORIGIN, 'user-agent': HUMAN_UA, 'cf-connecting-ip': '203.0.113.10' }, body, cf });
      expect(req.headers.get('content-length')).toBeNull();
      return app.fetch(req, env, new TestExecutionContext() as unknown as ExecutionContext);
    };
    // A body that never ends: reading it whole would never finish.
    const endless = new ReadableStream<Uint8Array>({ pull: (c) => c.enqueue(new Uint8Array(1024).fill(32)) });
    expect((await send(endless)).status).toBe(413);
    const small = new TextEncoder().encode(JSON.stringify(viewPayload()));
    expect((await send(new ReadableStream<Uint8Array>({ start: (c) => (c.enqueue(small), c.close()) }))).status).toBe(204);
    expect(await count('visits')).toBe(1);
  });
});
