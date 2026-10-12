import { env } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertVisit, type NewVisit } from '@yardsign/db';
import { MockProvider } from '@yardsign/identity';
import { accessIssuer, verifyAccessJwt } from '../src/access';
import { adminStats, attentionItems, browserFamily, DELIVR_RATES, deviceBucket, deviceLabel, estimateDelivrUsd, exploreData, FLAG, OUTCOME_KINDS, sourceLabel, visitOutcome, type ExploreData, type SiteSummary } from '../src/admin-stats';
import { app } from '../src/app';
import { createLogger } from '../src/log';
import { processVisit } from '../src/resolution';
import { HUMAN_UA, SITE_ID, adminHeaders, uuidFrom } from './helpers';

const log = createLogger({ req_id: 'test' });

/** Count people per funnel step from the explore rows, the same way the page's script does. */
function tally(x: ExploreData, since: number, until = Infinity) {
  const by = new Map<number, { f: number; fam: number; why: number }>();
  for (const r of x.rows) {
    if (r[0] < since || r[0] >= until) continue;
    const p = by.get(r[1]) ?? { f: 0, fam: r[3], why: -1 };
    p.f |= r[9];
    p.fam = r[3];
    if (r[11] >= 0) p.why = r[11];
    by.set(r[1], p);
  }
  const zero = () => ({ visitors: 0, eligible: 0, asked: 0, matched: 0, leads: 0 });
  const all = zero();
  const fam = [zero(), zero(), zero()];
  const why: Record<string, number> = {};
  for (const p of by.values()) {
    let f = p.f;
    if (f & FLAG.lead) f |= FLAG.matched;
    if (f & FLAG.matched) f |= FLAG.asked;
    if (f & FLAG.asked) f |= FLAG.eligible;
    for (const c of [all, fam[p.fam]!]) {
      c.visitors++;
      if (f & FLAG.eligible) c.eligible++;
      if (f & FLAG.asked) c.asked++;
      if (f & FLAG.matched) c.matched++;
      if (f & FLAG.lead) c.leads++;
    }
    if (f & FLAG.matched && !(f & FLAG.lead) && p.why >= 0) why[x.dict.why[p.why]!] = (why[x.dict.why[p.why]!] ?? 0) + 1;
  }
  return { all, fam, why };
}
const TEAM = 'yardsign';
const ISSUER = 'https://yardsign.cloudflareaccess.com';
const AUD = 'a'.repeat(64);
const ACCESS_ENV = { ...env, CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD };

// ---------- a tiny Access look-alike: one RSA key pair, a JWKS document, signed tokens ----------

type Jwk = JsonWebKey & { kid: string };
interface KeyPair { kid: string; priv: CryptoKey; jwk: Jwk }
let good: KeyPair;
let other: KeyPair;
let realFetch: typeof fetch;

const b64url = (bytes: ArrayBuffer | Uint8Array): string => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const enc = (o: unknown): string => b64url(new TextEncoder().encode(JSON.stringify(o)));

async function makeKey(kid: string): Promise<KeyPair> {
  const pair = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  return { kid, priv: pair.privateKey, jwk: { kid, kty: 'RSA', alg: 'RS256', use: 'sig', n: jwk.n, e: jwk.e } };
}

async function sign(key: KeyPair, payload: Record<string, unknown>, header: Record<string, unknown> = { alg: 'RS256', kid: key.kid, typ: 'JWT' }): Promise<string> {
  const h = enc(header);
  const p = enc(payload);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.priv, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(sig)}`;
}

const nowS = () => Math.floor(Date.now() / 1000);
const claims = (over: Record<string, unknown> = {}) => ({ aud: [AUD], email: 'owner@example.com', exp: nowS() + 3600, iat: nowS(), nbf: nowS() - 10, iss: ISSUER, sub: 'user-1', type: 'app', ...over });

function jwksFetch(keys: Jwk[], calls = { n: 0 }): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    calls.n++;
    expect(String(input)).toBe(`${ISSUER}/cdn-cgi/access/certs`);
    return new Response(JSON.stringify({ keys, public_certs: [] }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

beforeAll(async () => {
  good = await makeKey('kid-good');
  other = await makeKey('kid-other');
  // The app-level tests go through the real fetch; stand in for Access's certs endpoint and refuse everything else.
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === `${ISSUER}/cdn-cgi/access/certs`) return new Response(JSON.stringify({ keys: [good.jwk], public_certs: [] }), { headers: { 'content-type': 'application/json' } });
    throw new Error(`unexpected fetch in test: ${String(input)}`);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe('verifyAccessJwt', () => {
  const cfg = { teamDomain: TEAM, aud: AUD };

  it('normalizes the team domain', () => {
    expect(accessIssuer('yardsign')).toBe(ISSUER);
    expect(accessIssuer('yardsign.cloudflareaccess.com')).toBe(ISSUER);
    expect(accessIssuer('https://Yardsign.cloudflareaccess.com/')).toBe(ISSUER);
    expect(accessIssuer('evil.example.com')).toBeNull();
    expect(accessIssuer('')).toBeNull();
  });

  it('accepts a token signed by a published key for the right team and audience', async () => {
    const v = await verifyAccessJwt(await sign(good, claims()), cfg, { fetchFn: jwksFetch([good.jwk]), cache: new Map() });
    expect(v).toEqual({ ok: true, identity: { email: 'owner@example.com', sub: 'user-1' } });
  });

  it('fails closed on missing config, missing token, or garbage', async () => {
    const token = await sign(good, claims());
    expect((await verifyAccessJwt(token, { teamDomain: undefined, aud: AUD }, { cache: new Map() })).ok).toBe(false);
    expect((await verifyAccessJwt(token, { teamDomain: TEAM, aud: '' }, { cache: new Map() })).ok).toBe(false);
    expect((await verifyAccessJwt(null, cfg, { cache: new Map() })).ok).toBe(false);
    expect((await verifyAccessJwt('', cfg, { cache: new Map() })).ok).toBe(false);
    expect((await verifyAccessJwt('not.a.jwt', cfg, { cache: new Map() })).ok).toBe(false);
    expect((await verifyAccessJwt('a.b', cfg, { cache: new Map() })).ok).toBe(false);
  });

  it('rejects the wrong team, the wrong audience, an expired token and the "none" algorithm', async () => {
    const o = { fetchFn: jwksFetch([good.jwk]), cache: new Map() };
    expect(await verifyAccessJwt(await sign(good, claims({ iss: 'https://other.cloudflareaccess.com' })), cfg, o)).toMatchObject({ ok: false, reason: 'wrong issuer' });
    expect(await verifyAccessJwt(await sign(good, claims({ aud: ['b'.repeat(64)] })), cfg, o)).toMatchObject({ ok: false, reason: 'wrong audience' });
    expect(await verifyAccessJwt(await sign(good, claims({ aud: AUD })), cfg, o)).toMatchObject({ ok: true }); // a bare string aud is fine too
    expect(await verifyAccessJwt(await sign(good, claims({ exp: nowS() - 600 })), cfg, o)).toMatchObject({ ok: false, reason: 'expired' });
    expect(await verifyAccessJwt(await sign(good, claims({ nbf: nowS() + 600 })), cfg, o)).toMatchObject({ ok: false, reason: 'not yet valid' });
    expect(await verifyAccessJwt(await sign(good, claims(), { alg: 'none', kid: good.kid }), cfg, o)).toMatchObject({ ok: false, reason: 'unsupported token' });
    expect(await verifyAccessJwt(await sign(good, claims(), { alg: 'RS256' }), cfg, o)).toMatchObject({ ok: false, reason: 'unsupported token' });
  });

  it('rejects a token signed by a key Access did not publish, and a tampered payload', async () => {
    const calls = { n: 0 };
    const o = { fetchFn: jwksFetch([good.jwk], calls), cache: new Map() };
    // Unknown kid: refreshes the key set once, then gives up.
    expect(await verifyAccessJwt(await sign(other, claims()), cfg, o)).toMatchObject({ ok: false, reason: 'unknown signing key' });
    expect(calls.n).toBe(2);
    // Same kid as the real key, different private key.
    const forged = await sign({ ...other, kid: good.kid }, claims());
    expect(await verifyAccessJwt(forged, cfg, o)).toMatchObject({ ok: false, reason: 'bad signature' });
    // Real signature, edited claims.
    const real = await sign(good, claims());
    const [h, , s] = real.split('.') as [string, string, string];
    expect(await verifyAccessJwt(`${h}.${enc(claims({ email: 'someone@else.com' }))}.${s}`, cfg, o)).toMatchObject({ ok: false, reason: 'bad signature' });
    // Keys are cached: the two calls above added none.
    expect(calls.n).toBe(2);
  });

  it('forces at most one key refresh per minute for unknown keys', async () => {
    const calls = { n: 0 };
    let now = Date.now();
    const o = { fetchFn: jwksFetch([good.jwk], calls), cache: new Map(), now: () => now };
    expect(await verifyAccessJwt(await sign(other, claims()), cfg, o)).toMatchObject({ ok: false, reason: 'unknown signing key' });
    expect(calls.n).toBe(2); // the first load, then one forced refresh
    for (let i = 0; i < 5; i++) expect(await verifyAccessJwt(await sign(other, claims()), cfg, o)).toMatchObject({ ok: false, reason: 'unknown signing key' });
    expect(calls.n).toBe(2); // junk tokens in the same minute fetch nothing
    expect((await verifyAccessJwt(await sign(good, claims()), cfg, o)).ok).toBe(true); // the real key still works from the cache
    now += 61_000;
    await verifyAccessJwt(await sign(other, claims()), cfg, o);
    expect(calls.n).toBe(3); // a minute later, one more
  });

  it('refuses when the certs endpoint is down', async () => {
    const down = (async () => new Response('nope', { status: 503 })) as typeof fetch;
    expect((await verifyAccessJwt(await sign(good, claims()), cfg, { fetchFn: down, cache: new Map() })).ok).toBe(false);
  });
});

// ---------- the page ----------

const get = (path: string, token?: string, e: typeof env = ACCESS_ENV) => app.fetch(new Request(`http://localhost:8787${path}`, { headers: token ? { 'Cf-Access-Jwt-Assertion': token } : {} }), e);

function visitRow(visitorId: string, over: Partial<NewVisit> = {}): NewVisit {
  return {
    id: crypto.randomUUID(), site_id: SITE_ID, visitor_id: visitorId, session_id: 'sess_abcdefgh', url: 'http://localhost:3000/roof-repair', path: '/roof-repair',
    referrer: null, title: null, ip_hash: 'h', ip_raw: '203.0.113.77', country: 'US', region: 'TX', city: 'Plano', postal: '75024', asn: 7018, colo: null,
    lat: null, lng: null, user_agent: 'Mozilla/5.0', device: '{}', screen: '{}', timezone: null, language: null, bot_score: null,
    occurred_at: Date.now(), created_at: Date.now(), gpc: 0, asn_org: 'AT&T', asn_class: 'residential', ...over,
  };
}

async function resolvable(): Promise<string> {
  const p = new MockProvider();
  for (let i = 0; i < 500; i++) {
    const vid = uuidFrom(i);
    const r = await p.resolve({ visitor_id: vid, visit_id: 'x', site_id: SITE_ID, ip: null, ip_hash: 'h', user_agent: null, geo: { country: null, region: null, city: null, postal: null, lat: null, lng: null, asn: null }, occurred_at: 0, created_at: 0 });
    if (r.status === 'resolved') return vid;
  }
  throw new Error('mock never resolved');
}

describe('/admin access control', () => {
  it('returns 403 without a token, with a bad token, or when Access is not configured', async () => {
    for (const res of [await get('/admin'), await get('/admin', 'garbage'), await get('/admin', await sign(other, claims())), await get('/admin', await sign(good, claims()), env)]) {
      expect(res.status).toBe(403);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('x-robots-tag')).toContain('noindex');
      expect(await res.text()).toContain('Forbidden');
    }
    expect((await get(`/admin/leads/${crypto.randomUUID()}`)).status).toBe(403);
    // The email header alone is not a login.
    const spoof = await app.fetch(new Request('http://localhost:8787/admin', { headers: { 'Cf-Access-Authenticated-User-Email': 'owner@example.com' } }), ACCESS_ENV);
    expect(spoof.status).toBe(403);
  });

  it('opens with a valid Access token', async () => {
    const res = await get('/admin', await sign(good, claims()));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const html = await res.text();
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain('class="mode mock"');
    expect(html).toContain('MOCK');
  });

  it('leaves the bearer-token JSON API alone', async () => {
    const res = await app.fetch(new Request('http://localhost:8787/api/admin/sites', { headers: adminHeaders() }), ACCESS_ENV);
    expect(res.status).toBe(200);
    expect((await app.fetch(new Request('http://localhost:8787/api/admin/sites'), ACCESS_ENV)).status).toBe(401);
  });
});

describe('/admin content', () => {
  it('shows LIVE in red when the provider is not mock', async () => {
    const html = await (await get('/admin', await sign(good, claims()), { ...ACCESS_ENV, IDENTITY_PROVIDER: 'delivr' })).text();
    expect(html).toContain('class="mode live"');
    expect(html).toContain('LIVE');
  });

  it('shows every section with real numbers and keeps personal details off the page', async () => {
    const vid = await resolvable();
    const v = visitRow(vid);
    await insertVisit(env.DB, v);
    expect((await processVisit(env, v.id, log)).outcome).toBe('resolved');
    // On the founder's site (which has a Delivr pixel): a skipped visit, a waiting visit, and a page path that tries to break out of the script tag.
    await insertVisit(env.DB, visitRow(uuidFrom(900), { region: 'OK', site_id: 'site_yardsign' }));
    await env.DB.prepare("UPDATE visits SET skip_reason = 'not_allowed_state', resolve_attempted_at = ? WHERE visitor_id = ?").bind(Date.now(), uuidFrom(900)).run();
    await insertVisit(env.DB, visitRow(uuidFrom(901), { site_id: 'site_yardsign', url: 'https://tryyardsign.com/roof-repair?utm_source=facebook&utm_medium=paid_social&utm_campaign=match-test-oct8&utm_content=desktop' }));
    await insertVisit(env.DB, visitRow(uuidFrom(902), { site_id: 'site_yardsign', path: '/x</script><script>alert(1)</script>' }));
    // A failed delivery to show up in delivery health and the attention list.
    const lead = await env.DB.prepare('SELECT * FROM leads LIMIT 1').first<{ id: string; address_line1: string; phone: string; email: string; first_name: string; last_name: string }>();
    await env.DB.prepare("INSERT INTO deliveries (id, lead_id, channel, status, attempts, last_error, payload, created_at) VALUES (?, ?, 'webhook:slack', 'failed', 1, 'webhook 500: boom', '{}', ?)").bind(crypto.randomUUID(), lead!.id, Date.now()).run();

    const html = await (await get('/admin', await sign(good, claims()))).text();
    for (const s of ['Needs attention', '1 lead delivery failed in the last 24 hours (Slack)', 'Delivr spend', 'What happened to each visitor', 'Match funnel', 'Match rate by browser', 'Where they came from', 'Visits', 'Recent leads', 'Delivery health', 'Recent failures', 'webhook 500: boom', 'Sites', 'How these numbers are counted']) expect(html).toContain(s);
    expect(html).toContain('Test site (localhost)');
    expect(html).toContain('tryyardsign.com');
    expect(html).toContain('test@example.com'); // owner email on the sites table
    expect(html).toContain(lead!.first_name);
    expect(html).toContain(`/admin/leads/${lead!.id}`);
    // The page data can not end the script tag early.
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('/x\\u003c/script>');
    // The leads list never shows home address, phone, email or raw IP; extras never appear anywhere.
    expect(html).not.toContain(lead!.address_line1);
    expect(html).not.toContain(lead!.phone);
    expect(html).not.toContain(lead!.email);
    expect(html).not.toContain('203.0.113.77');
    for (const s of ['income', 'net_worth', 'is_married', 'has_children']) expect(html).not.toContain(s);
    // Nothing on the page edits anything: buttons only sort and filter in the browser.
    expect(html).not.toMatch(/<form|method="post"/i);

    const data = JSON.parse(html.slice(html.indexOf('<script type="application/json" id="explore-data">') + 50, html.indexOf('</script>', html.indexOf('id="explore-data"')))) as ExploreData;
    const st = await adminStats(env.DB);
    expect(data.rows).toEqual(st.explore.rows);
    // Only sites that use Delivr; the mock test site is left out.
    expect(st.explore.dict.site).toEqual(['tryyardsign.com']);
    expect(st.explore.rows).toHaveLength(3);
    const skipped = st.explore.rows.find((r) => r[10] >= 0)!;
    const waiting = st.explore.rows.find((r) => r[10] < 0 && st.explore.dict.path[r[6]] === '/roof-repair')!;
    expect(st.explore.dict.skip[skipped[10]]).toBe('Visit from outside Texas');
    expect(skipped[9] & FLAG.eligible).toBe(0);
    expect(st.explore.dict.out[skipped[13]]).toBe('Visit from outside Texas');
    expect(waiting[9]).toBe(FLAG.eligible | FLAG.delivrSite);
    expect(OUTCOME_KINDS[waiting[12]]).toBe('waiting');
    expect(st.explore.dict.place[waiting[7]]).toBe('Plano, TX');
    expect(st.explore.dict.net[waiting[8]]).toBe('AT&T');
    expect(st.explore.dict.src[waiting[16]]).toBe('facebook · paid_social · desktop');
    expect(st.explore.dict.src[skipped[16]]).toBe('No tag, no referrer');
    // The explore payload holds no person fields.
    const payload = JSON.stringify(st.explore);
    for (const x of [lead!.first_name, lead!.last_name, lead!.address_line1, lead!.phone, lead!.email, '203.0.113.77']) expect(payload).not.toContain(x);

    expect(st.attention).toEqual([{ level: 'bad', text: '1 lead delivery failed in the last 24 hours (Slack). The roofer may not have the lead.', href: '#delivery' }]);
    expect(st.channels.find((c) => c.channel === 'webhook:slack')?.failed).toBe(1);
    expect(st.failures[0]).toMatchObject({ channel: 'webhook:slack', error: 'webhook 500: boom', siteName: 'Test site (localhost)' });
    expect(st.sites.find((s) => s.id === SITE_ID)).toMatchObject({ visits30: 1, leads30: 1, sent30: 1, matchRate30: 100, ownerEmail: 'test@example.com' });
    expect(st.leads).toHaveLength(1);
    expect(st.leads[0]).toMatchObject({ id: lead!.id, status: 'delivered' });
    expect(st.leads[0]?.city).toMatch(/, TX$/); // the person's city, not the connection's
  });

  it('lists only things to act on: spend near a cap, cap blocks, errors, stuck visits, a quiet site', () => {
    const now = Date.now();
    const spend = { monthCents: 100_000, dayCents: 1_000, monthCapCents: 125_000, dayCapCents: 5_000 };
    const site = (over: Partial<SiteSummary>): SiteSummary => ({ id: 's', name: 'roofer.example', siteKey: 'K', active: true, ownerEmail: '', installSeenAt: now, visits30: 0, sent30: 0, leads30: 0, matchRate30: null, spend30Usd: 0, channels: [], delivr: true, ...over });
    expect(attentionItems({ spend: { ...spend, monthCents: 0 }, health: {}, sites: [site({})], now })).toEqual([]);
    const items = attentionItems({
      spend,
      health: { capped_24h: 2, errors_24h: 1, stuck: 3 },
      sites: [site({ installSeenAt: now - 30 * 3_600_000 }), site({ name: 'mock.example', delivr: false, installSeenAt: now - 30 * 3_600_000 }), site({ name: 'gone.example', installSeenAt: now - 40 * 86_400_000 })],
      now,
    });
    expect(items.map((i) => i.text)).toEqual([
      'The Delivr spend cap stopped 2 lookups in the last 24 hours. Those visitors were not looked up.',
      'Delivr spend this month is $1,000.00 of the $1,250.00 monthly cap.',
      '1 lookup failed with an error in the last 24 hours. Look for "Lookup failed" in the visit list.',
      '3 visits have waited more than 30 minutes for a lookup. The 5-minute check may be stuck.',
      'roofer.example has had no visits for 30 hours. Check that the tag is still on the site.',
    ]);
    expect(items[0]?.level).toBe('bad');
  });

  it('says in plain words what happened to each visit', () => {
    const base = { skip_reason: null, resolve_attempted_at: null, req_status: null, lead_id: null };
    expect(visitOutcome(base).kind).toBe('waiting');
    expect(visitOutcome({ ...base, lead_id: 'l1', req_status: 'resolved' }).kind).toBe('lead');
    expect(visitOutcome({ ...base, resolve_attempted_at: 1, req_status: 'no_match' })).toEqual({ kind: 'no_match', label: 'Looked up, no match' });
    expect(visitOutcome({ ...base, resolve_attempted_at: 1, skip_reason: 'deduped_24h' }).label).toBe('Already asked about in the last 24 hours');
    expect(visitOutcome({ ...base, resolve_attempted_at: 1, skip_reason: 'no_address_state' }).label).toBe('Matched, no state on record (not sent)');
    expect(visitOutcome({ ...base, resolve_attempted_at: 1, req_status: 'error' }).kind).toBe('error');
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')).toBe('iPhone · Safari');
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36')).toBe('Windows · Chrome');
    expect(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15')).toBe('Mac · Safari');
  });

  it('counts Delivr spend the way the cap does, one person per visitor, and prices site rows with the rate constant', async () => {
    const v = visitRow(uuidFrom(910), { site_id: 'site_yardsign' });
    await insertVisit(env.DB, v);
    const ins = (status: string, payload: string) =>
      env.DB.prepare("INSERT INTO identity_requests (id, visit_id, provider, status, request_payload, response_payload, cost_cents, created_at, completed_at) VALUES (?, ?, 'delivr', ?, '{}', ?, 3, ?, ?)").bind(crypto.randomUUID(), v.id, status, payload, Date.now(), Date.now()).run();
    await ins('resolved', JSON.stringify({ row: { x: 1 }, rows: 1, meta: null }));
    await ins('no_match', JSON.stringify({ rows: 2, unmatched: true }));
    await ins('no_match', JSON.stringify({ rows: 0 }));
    await ins('error', JSON.stringify({ error: 'boom', raw: null }));
    const st = await adminStats(env.DB);
    // Four requests for one visitor still count as one person asked and one matched.
    expect(tally(st.explore, 0).all).toMatchObject({ visitors: 1, eligible: 1, asked: 1, matched: 1, leads: 0 });
    expect(st.explore.rows[0]![14]).toBe(12); // cost_cents, the way the cap counts
    expect(st.spend).toMatchObject({ monthCents: 12, dayCents: 12, monthCapCents: 125_000, dayCapCents: 5_000 });
    expect(estimateDelivrUsd(1000, 0)).toBe(DELIVR_RATES.fullProfileUsdPer1000);
    expect(estimateDelivrUsd(0, 1000)).toBe(DELIVR_RATES.webEventUsdPer1000);
    expect(estimateDelivrUsd(0, 0)).toBe(0);
    expect(st.sites.find((s) => s.id === 'site_yardsign')?.spend30Usd).toBe(estimateDelivrUsd(3, 1));
  });

  it('records the pixel being fetched and shows it as install seen', async () => {
    let st = await adminStats(env.DB);
    expect(st.sites.find((s) => s.id === SITE_ID)?.installSeenAt).toBeNull();
    expect((await app.fetch(new Request('http://localhost:8787/p/TESTKEY.js'), env)).status).toBe(200);
    const first = await env.DB.prepare('SELECT pixel_seen_at FROM sites WHERE id = ?').bind(SITE_ID).first<{ pixel_seen_at: number }>();
    expect(first?.pixel_seen_at).toBeGreaterThan(0);
    await app.fetch(new Request('http://localhost:8787/p/TESTKEY.js'), env);
    const second = await env.DB.prepare('SELECT pixel_seen_at FROM sites WHERE id = ?').bind(SITE_ID).first<{ pixel_seen_at: number }>();
    expect(second?.pixel_seen_at).toBe(first?.pixel_seen_at); // throttled
    st = await adminStats(env.DB);
    expect(st.sites.find((s) => s.id === SITE_ID)?.installSeenAt).toBe(first?.pixel_seen_at);
    const html = await (await get('/admin', await sign(good, claims()))).text();
    expect(html).toContain('just now');
  });

  it('lead detail shows the card fields, nothing more, and 404s on an unknown id', async () => {
    const vid = await resolvable();
    const v = visitRow(vid);
    await insertVisit(env.DB, v);
    const r = await processVisit(env, v.id, log);
    const res = await get(`/admin/leads/${r.leadId}`, await sign(good, claims()));
    expect(res.status).toBe(200);
    const html = await res.text();
    const lead = await env.DB.prepare('SELECT * FROM leads WHERE id = ?').bind(r.leadId).first<{ address_line1: string; phone: string; email: string }>();
    expect(html).toContain(lead!.address_line1);
    expect(html).toContain(lead!.phone);
    expect(html).toContain(lead!.email);
    expect(html).toContain('Plano, TX'); // connection city from the visit
    expect(html).toContain('/roof-repair');
    expect(html).toContain('Mock person');
    expect(html).toContain('>delivered<');
    expect(html).not.toContain('203.0.113.77');
    // A month-old lead still shows the pages that led to it (the window ends at the lead, not today).
    const old = Date.now() - 30 * 86_400_000;
    await env.DB.prepare('UPDATE visits SET occurred_at = ? WHERE id = ?').bind(old - 60_000, v.id).run();
    await env.DB.prepare('UPDATE leads SET created_at = ? WHERE id = ?').bind(old, r.leadId).run();
    expect(await (await get(`/admin/leads/${r.leadId}`, await sign(good, claims()))).text()).toContain('/roof-repair');
    expect((await get(`/admin/leads/${crypto.randomUUID()}`, await sign(good, claims()))).status).toBe(404);
    expect((await get('/admin/leads/..%2Fsites', await sign(good, claims()))).status).toBe(404);
  });
});

describe('/admin match funnel', () => {
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const IPHONE_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1';
  const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
  const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
  const FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0';
  const EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0';
  const DAY = 86_400_000;

  it('sorts browsers into Chromium, Safari and other', () => {
    expect(browserFamily(HUMAN_UA)).toBe('chromium');
    expect(browserFamily(EDGE)).toBe('chromium');
    expect(browserFamily(ANDROID)).toBe('chromium');
    expect(browserFamily(IPHONE)).toBe('safari');
    expect(browserFamily(IPHONE_CHROME)).toBe('safari'); // every iPhone browser runs on Safari
    expect(browserFamily(MAC_SAFARI)).toBe('safari');
    expect(browserFamily(FIREFOX)).toBe('other');
    expect(browserFamily(null)).toBe('other');
  });

  it('counts each person once, Delivr only, split by browser, with matches we withheld', async () => {
    const now = Date.now();
    const visit = async (n: number, ua: string, ago = 0, over: Partial<NewVisit> = {}, skip: string | null = null): Promise<string> => {
      const v = visitRow(uuidFrom(n), { site_id: 'site_yardsign', user_agent: ua, created_at: now - ago, occurred_at: now - ago, ...over });
      await insertVisit(env.DB, v);
      if (skip) await env.DB.prepare('UPDATE visits SET skip_reason = ?, resolve_attempted_at = ? WHERE id = ?').bind(skip, now, v.id).run();
      return v.id;
    };
    const ask = async (visitId: string, status: string, payload: unknown, provider = 'delivr'): Promise<string> => {
      const id = crypto.randomUUID();
      await env.DB.prepare("INSERT INTO identity_requests (id, visit_id, provider, status, request_payload, response_payload, cost_cents, created_at, completed_at) VALUES (?, ?, ?, ?, '{}', ?, 0, ?, ?)").bind(id, visitId, provider, status, JSON.stringify(payload), now, now).run();
      return id;
    };
    const lead = async (reqId: string, siteId: string, visitorId: string) =>
      env.DB.prepare("INSERT INTO leads (id, site_id, visitor_id, identity_request_id, first_name, state, created_at) VALUES (?, ?, ?, ?, 'Pat', 'TX', ?)").bind(crypto.randomUUID(), siteId, visitorId, reqId, now).run();

    // A: Chrome, two page views, matched and became a lead.
    await visit(1, HUMAN_UA, 60_000);
    await lead(await ask(await visit(1, HUMAN_UA), 'resolved', { rows: 1 }), 'site_yardsign', uuidFrom(1));
    // B: Android, matched but lives outside Texas.
    await ask(await visit(2, ANDROID, 0, {}, 'out_of_state_address'), 'resolved', { rows: 1, withheld: 'out_of_state_address' });
    // C: Chrome, no match. D: iPhone, no match. E: Mac Safari, no match, 3 days ago.
    await ask(await visit(3, HUMAN_UA), 'no_match', { rows: 0 });
    await ask(await visit(4, IPHONE), 'no_match', { rows: 0 });
    await ask(await visit(5, MAC_SAFARI, 3 * DAY), 'no_match', { rows: 0 });
    // F: iPhone from Oklahoma, stopped at gate 1.
    await visit(6, IPHONE, 0, { region: 'OK' }, 'not_allowed_state');
    // G: Chrome, matched, too unsure to send, 2 days ago.
    await ask(await visit(7, HUMAN_UA, 2 * DAY), 'resolved', { rows: 1 });
    // H: Firefox, could be looked up, already asked about before this week.
    await visit(8, FIREFOX, 0, {}, 'deduped_30d');
    // O: Android, matched but opted out.
    await ask(await visit(9, ANDROID, 0, {}, 'opted_out'), 'no_match', { opted_out: true });
    // M: a mock lead on the test site (no Delivr pixel). Left out of the funnel.
    const m = visitRow(uuidFrom(10));
    await insertVisit(env.DB, m);
    await lead(await ask(m.id, 'resolved', { mock: true }, 'mock'), SITE_ID, uuidFrom(10));
    // An old visit, 10 days ago, outside both windows.
    await ask(await visit(11, HUMAN_UA, 10 * DAY), 'resolved', { rows: 1 });

    const st = await adminStats(env.DB, { now });
    const w7 = tally(st.explore, now - 7 * DAY);
    expect(w7.all).toEqual({ visitors: 9, eligible: 8, asked: 7, matched: 4, leads: 1 });
    expect(w7.fam[0]).toEqual({ visitors: 5, eligible: 5, asked: 5, matched: 4, leads: 1 });
    expect(w7.fam[1]).toEqual({ visitors: 3, eligible: 2, asked: 2, matched: 0, leads: 0 });
    expect(w7.fam[2]).toEqual({ visitors: 1, eligible: 1, asked: 0, matched: 0, leads: 0 });
    expect(w7.why).toEqual({ 'Lives outside Texas': 1, 'Opted out': 1, 'Too unsure to send (low match score)': 1 });

    const w1 = tally(st.explore, now - DAY);
    expect(w1.all).toEqual({ visitors: 7, eligible: 6, asked: 5, matched: 3, leads: 1 });
    expect(w1.fam[0]).toEqual({ visitors: 4, eligible: 4, asked: 4, matched: 3, leads: 1 });
    expect(w1.why).toEqual({ 'Lives outside Texas': 1, 'Opted out': 1 });

    // The old visitor, 10 days ago, is in the data for the 30-day view; the mock lead's site is not.
    expect(tally(st.explore, now - 30 * DAY).all.visitors).toBe(10);
    // Device buckets and browser families travel with each row.
    const iphoneRows = st.explore.rows.filter((r) => st.explore.dict.dev[r[5]] === 'iPhone · Safari');
    expect(iphoneRows.length).toBe(2);
    expect(iphoneRows.every((r) => r[3] === 1 && r[4] === 0)).toBe(true);

    const html = await (await get('/admin', await sign(good, claims()))).text();
    expect(html).toContain('Match funnel');
    expect(html).toContain('Safari and iPhone almost never match (Delivr says under 1%).');
    expect(html).toContain('Chrome, Edge and Android');
    expect(html).toContain('Safari (iPhone and Mac)');
    expect(html).toContain('Lives outside Texas');
  });
});

describe('sourceLabel', () => {
  it('names the utm tags, else the referring site, else no referrer', () => {
    expect(sourceLabel('https://tryyardsign.com/?utm_source=sms&utm_medium=personal&utm_campaign=match-test-oct8', null)).toBe('sms · personal');
    expect(sourceLabel('https://tryyardsign.com/?utm_source=google&utm_medium=cpc&utm_content=all_devices', 'https://www.google.com/')).toBe('google · cpc · all_devices');
    expect(sourceLabel('https://tryyardsign.com/', 'https://www.google.com/')).toBe('No tag, from google.com');
    expect(sourceLabel('https://tryyardsign.com/', 'https://www.tryyardsign.com/privacy')).toBe('No tag, from another page on the site');
    expect(sourceLabel('https://tryyardsign.com/', null)).toBe('No tag, no referrer');
    expect(sourceLabel('not a url', 'android-app://com.slack')).toBe('No tag, no referrer');
    expect(sourceLabel(`https://tryyardsign.com/?utm_source=${'x'.repeat(100)}`, null)).toBe('x'.repeat(40));
  });
});

describe('/admin explore rows', () => {
  it('labels every row the same as parsing its user agent and link fresh, with each label listed once', () => {
    const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
    const IPAD = 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
    const uas = [HUMAN_UA, IPHONE, null, HUMAN_UA, IPAD, null, IPHONE, 'curl/8.0'];
    const urls = ['https://tryyardsign.com/?utm_source=sms&utm_medium=personal', 'https://tryyardsign.com/', null];
    const refs = ['https://www.google.com/', null];
    const rows = uas.map((ua, i) => ({
      at: 10_000 - i, site_id: 'site_yardsign', visitor_id: `vid_${i % 3}`, ua, url: urls[i % 3] ?? null, referrer: refs[i % 2] ?? null, path: '/', city: 'Plano', region: 'TX',
      asn_org: null, skip_reason: null, resolve_attempted_at: null, site_name: 'Yardsign', delivr_site: 1, ok1: 1, asked: 0, matched: 0, dlead: 0, why: null, cents: 0, lead_id: null, req_status: null,
    }));
    const x = exploreData(rows, ['TX'], 20_000, 0);
    const oldestFirst = [...rows].reverse();
    expect(x.rows).toHaveLength(rows.length);
    x.rows.forEach((r, i) => {
      const src = oldestFirst[i]!;
      expect(r[3]).toBe(['chromium', 'safari', 'other'].indexOf(browserFamily(src.ua)));
      expect(r[4]).toBe(['ios', 'android', 'desktop', 'other'].indexOf(deviceBucket(src.ua)));
      expect(x.dict.dev[r[5]]).toBe(deviceLabel(src.ua));
      expect(x.dict.src[r[16]]).toBe(sourceLabel(src.url, src.referrer));
    });
    expect(new Set(x.dict.dev).size).toBe(x.dict.dev.length);
    expect(new Set(x.dict.src).size).toBe(x.dict.src.length);
  });

  it('has the indexes migration 0014 adds for /admin and the cron', async () => {
    const want = ['idx_deliveries_created', 'idx_idreq_created', 'idx_visits_created', 'idx_visits_site_created', 'idx_visits_site_session'];
    const got = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (${want.map(() => '?').join(', ')}) ORDER BY name`).bind(...want).all<{ name: string }>();
    expect(got.results.map((r) => r.name)).toEqual(want);
  });
});
