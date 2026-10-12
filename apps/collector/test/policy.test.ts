/**
 * The Texas-only rule (src/policy.ts), end to end: gate 1 at the pixel, gate 1 again before a
 * lookup, gates 2 and 3 before a lead is delivered, the admin counts and the public promises.
 */
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashEmail, insertVisit, optOut, pendingRecalls, scrubWithheldResponses, DAY_MS, type LeadRow, type NewVisit } from '@yardsign/db';
import type { IdentityProvider, LeadFields, ResolveResult } from '@yardsign/identity';
import { adminStats } from '../src/admin-stats';
import { app } from '../src/app';
import type { DeliveryChannel } from '../src/delivery';
import type { Env } from '../src/env';
import { createLogger } from '../src/log';
import { addBusinessDays, recallMessage } from '../src/optout-notice';
import { ALLOWED_STATES, allowedStates, costFilter, identityGate, leadGate, stateCode } from '../src/policy';
import { processVisit } from '../src/resolution';
import { PLANO_CF, SITE_ID, pixelRequest, type CfOverrides } from './helpers';

const log = createLogger({ req_id: 'test' });
const PIXEL = '11111111-2222-3333-4444-555555555555';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';

async function fetchPixel(cf: CfOverrides | null, opts: { ua?: string; headers?: Record<string, string>; env?: Partial<Env> } = {}) {
  const res = await app.fetch(pixelRequest('TESTKEY', { cf, ua: opts.ua, headers: opts.headers }), { ...env, ...opts.env });
  const js = await res.text();
  return { res, js, hasDelivr: js.includes(PIXEL), gate: res.headers.get('x-yardsign-gate') };
}

describe('the policy module', () => {
  it('allows Texas only, and expansion is one list', () => {
    expect(ALLOWED_STATES).toEqual(['TX']);
    expect(allowedStates({})).toEqual(['TX']);
    expect(allowedStates({ ALLOWED_STATES: 'tx, ok' })).toEqual(['TX', 'OK']);
  });

  it('gate 1 order: cost filter, GPC, country, unknown region, state', () => {
    const tx = { gpc: false, country: 'US', region: 'TX', asnClass: 'residential' as const };
    expect(identityGate(tx)).toEqual({ ok: true, reason: null });
    expect(identityGate({ ...tx, asnClass: 'mobile' }).ok).toBe(true);
    expect(identityGate({ ...tx, asnClass: 'relay' }).ok).toBe(true);
    expect(identityGate({ ...tx, asnClass: 'hosting' }).ok).toBe(true); // Private Relay, WARP, office VPNs
    expect(identityGate({ ...tx, bot: true, gpc: true, region: 'CA' }).reason).toBe('bot_or_datacenter');
    expect(identityGate({ ...tx, gpc: true }).reason).toBe('gpc');
    expect(identityGate({ ...tx, country: 'CA' }).reason).toBe('non_us');
    expect(identityGate({ ...tx, country: null }).reason).toBe('non_us');
    expect(identityGate({ ...tx, region: null }).ok).toBe(true); // unknown region: gate 2 checks the address
    expect(identityGate({ ...tx, region: 'Texas' }).ok).toBe(true);
    expect(identityGate({ ...tx, region: 'New Mexico' }).reason).toBe('not_allowed_state');
    expect(identityGate({ ...tx, region: 'OK' }).reason).toBe('not_allowed_state');
    expect(identityGate({ ...tx, region: 'OK' }, ['TX', 'OK']).ok).toBe(true);
    expect(costFilter({ asnClass: 'hosting' })).toBe(false);
    expect(costFilter({ asnClass: 'hosting', bot: true })).toBe(true);
    expect(costFilter({ asnClass: 'mobile' })).toBe(false);
  });

  it('reads full state names as codes (Delivr sometimes fills only the name)', () => {
    expect(stateCode('Texas')).toBe('TX');
    expect(stateCode(' texas ')).toBe('TX');
    expect(stateCode('New  Mexico')).toBe('NM');
    expect(stateCode('tx')).toBe('TX');
    expect(stateCode('Atlantis')).toBeNull();
  });

  it('gates 2 and 3: opt-out, GPC, then the home address or the visit in Texas', () => {
    const ok = { state: 'TX', optedOut: false, gpc: false };
    expect(leadGate(ok).ok).toBe(true);
    expect(leadGate({ ...ok, state: 'tx' }).ok).toBe(true);
    expect(leadGate({ ...ok, optedOut: true, visitRegion: 'TX' }).reason).toBe('opted_out');
    expect(leadGate({ ...ok, gpc: true }).reason).toBe('gpc');
    expect(leadGate({ ...ok, state: 'CA' }).reason).toBe('out_of_state_address');
    expect(leadGate({ ...ok, state: null }).reason).toBe('no_address_state');
    expect(leadGate({ ...ok, state: '' }).reason).toBe('no_address_state');
    expect(leadGate({ ...ok, state: 'OK' }, ['TX', 'OK']).ok).toBe(true);
    // Browsing from Texas counts as a Texas resident.
    expect(leadGate({ ...ok, state: null, visitRegion: 'TX' }).ok).toBe(true);
    expect(leadGate({ ...ok, state: 'CA', visitRegion: 'TX' }).ok).toBe(true);
    expect(leadGate({ ...ok, state: 'CA', visitRegion: 'CA' }).reason).toBe('out_of_state_address');
  });
});

describe('gate 1 at the pixel (/p/SITEKEY.js)', () => {
  beforeEach(async () => {
    await env.DB.prepare('UPDATE sites SET delivr_pixel_id = ? WHERE id = ?').bind(PIXEL, SITE_ID).run();
  });
  afterEach(async () => {
    await env.DB.prepare('UPDATE sites SET delivr_pixel_id = NULL WHERE id = ?').bind(SITE_ID).run();
  });

  it('Texas home broadband gets the Delivr id', async () => {
    const p = await fetchPixel(PLANO_CF);
    expect(p.res.status).toBe(200);
    expect(p.hasDelivr).toBe(true);
    expect(p.gate).toBe('pass');
  });

  it('Texas on a cell carrier gets the Delivr id', async () => {
    for (const org of ['T-Mobile USA', 'Verizon Wireless', 'AT&T Mobility']) {
      const p = await fetchPixel({ ...PLANO_CF, asOrganization: org }, { ua: ANDROID_UA });
      expect(p.hasDelivr, org).toBe(true);
    }
  });

  it('Texas on a VPN or Private Relay gets the Delivr id', async () => {
    for (const org of ['NordVPN', 'Mullvad VPN AB', 'iCloud Private Relay']) {
      const p = await fetchPixel({ ...PLANO_CF, asOrganization: org }, { ua: IPHONE_UA });
      expect(p.hasDelivr, org).toBe(true);
    }
  });

  it('any other state gets no Delivr id, reason not_allowed_state', async () => {
    for (const regionCode of ['CA', 'CT', 'NJ', 'OK']) {
      const p = await fetchPixel({ ...PLANO_CF, regionCode });
      expect(p.hasDelivr, regionCode).toBe(false);
      expect(p.gate, regionCode).toBe('not_allowed_state');
      expect(p.js).toContain('"TESTKEY"'); // our own beacon still loads
    }
  });

  it('a missing region still gets the Delivr id (gate 2 checks the address)', async () => {
    const { regionCode: _drop, ...noRegion } = PLANO_CF;
    const p = await fetchPixel(noRegion);
    expect(p.hasDelivr).toBe(true);
    expect(p.gate).toBe('pass');
  });

  it('non-US and Sec-GPC get no Delivr id', async () => {
    const mx = await fetchPixel({ ...PLANO_CF, country: 'MX' });
    expect(mx.hasDelivr).toBe(false);
    expect(mx.gate).toBe('non_us');
    const gpc = await fetchPixel(PLANO_CF, { headers: { 'sec-gpc': '1' } });
    expect(gpc.hasDelivr).toBe(false);
    expect(gpc.gate).toBe('gpc');
    // The browser-side check stays too.
    expect((await fetchPixel(PLANO_CF)).js).toContain('globalPrivacyControl');
  });

  it('a data-center network gets the Delivr id; a bot user agent does not', async () => {
    for (const org of ['Amazon.com', 'DigitalOcean, LLC', 'Google Cloud']) {
      const p = await fetchPixel({ ...PLANO_CF, asOrganization: org });
      expect(p.hasDelivr, org).toBe(true);
    }
    const curl = await fetchPixel(PLANO_CF, { ua: 'curl/8.5.0' });
    expect(curl.hasDelivr).toBe(false);
    expect(curl.gate).toBe('bot_or_datacenter');
  });

  it('is never public, and two visitors never share a cached copy', async () => {
    const tx = await fetchPixel(PLANO_CF);
    const ca = await fetchPixel({ ...PLANO_CF, regionCode: 'CA' });
    for (const p of [tx, ca]) {
      const cc = p.res.headers.get('cache-control') ?? '';
      expect(cc).toMatch(/^private/);
      expect(cc).not.toContain('public');
      expect(cc).not.toContain('immutable');
    }
    const txTag = tx.res.headers.get('etag');
    const caTag = ca.res.headers.get('etag');
    expect(txTag).toContain('pass');
    expect(caTag).toContain('not_allowed_state');
    expect(txTag).not.toBe(caTag);
    // A California browser that somehow holds the Texas ETag still gets a fresh file without the id.
    const res = await app.fetch(pixelRequest('TESTKEY', { cf: { ...PLANO_CF, regionCode: 'CA' }, headers: { 'if-none-match': txTag! } }), env);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(PIXEL);
    // The same visitor again gets a 304.
    expect((await app.fetch(pixelRequest('TESTKEY', { headers: { 'if-none-match': txTag! } }), env)).status).toBe(304);
  });

  it('stays under 4 KB with the Delivr id in it', async () => {
    const p = await fetchPixel(PLANO_CF);
    expect(new TextEncoder().encode(p.js).length).toBeLessThanOrEqual(4096);
  });

  it('ALLOWED_STATES = TX,OK lets Oklahoma through', async () => {
    const p = await fetchPixel({ ...PLANO_CF, regionCode: 'OK', city: 'Tulsa' }, { env: { ALLOWED_STATES: 'TX,OK' } });
    expect(p.hasDelivr).toBe(true);
    expect((await fetchPixel({ ...PLANO_CF, regionCode: 'CA' }, { env: { ALLOWED_STATES: 'TX,OK' } })).hasDelivr).toBe(false);
  });
});

describe('gate 2: the home address decides delivery', () => {
  function visit(over: Partial<NewVisit> = {}): NewVisit {
    return {
      id: crypto.randomUUID(), site_id: SITE_ID, visitor_id: crypto.randomUUID(), session_id: 'sess_abcdefgh', url: 'http://localhost:3000/', path: '/',
      referrer: null, title: null, ip_hash: 'h', ip_raw: null, country: 'US', region: 'TX', city: 'Dallas', postal: '75230', asn: 7018, colo: null,
      lat: null, lng: null, user_agent: 'Mozilla/5.0', device: '{}', screen: '{}', timezone: null, language: null, bot_score: null,
      occurred_at: Date.now(), created_at: Date.now(), gpc: 0, asn_org: 'AT&T', asn_class: 'residential', ...over,
    };
  }
  function provider(lead: LeadFields): IdentityProvider {
    return { name: 'fake', resolve: async (): Promise<ResolveResult> => ({ status: 'resolved', lead, confidence: 0.9, cost_cents: 3, raw: { row: { first_name: lead.first_name, state: lead.state }, rows: 1 } }) };
  }
  function channel(): DeliveryChannel & { sent: LeadRow[] } {
    const sent: LeadRow[] = [];
    return { name: 'test', sent, send: async (l: LeadRow) => void sent.push(l) };
  }
  const person = (state: string | undefined, email = 'pat@example.com'): LeadFields => ({ first_name: 'Pat', last_name: 'Example', address_line1: '1 Example Ln', city: 'Somewhere', state, zip: '00000', email });

  it('a Texas address is delivered', async () => {
    const v = visit();
    await insertVisit(env.DB, v);
    const ch = channel();
    const r = await processVisit(env, v.id, log, provider(person('TX')), ch);
    expect(r.outcome).toBe('resolved');
    expect(ch.sent).toHaveLength(1);
  });

  it('a California address on a Texas visit is delivered (browsing from Texas counts)', async () => {
    const v = visit();
    await insertVisit(env.DB, v);
    const ch = channel();
    const r = await processVisit(env, v.id, log, provider(person('CA')), ch);
    expect(r.outcome).toBe('resolved');
    expect(ch.sent).toHaveLength(1);
  });

  it('no state on the record, on a Texas visit, is delivered', async () => {
    const v = visit();
    await insertVisit(env.DB, v);
    const ch = channel();
    const r = await processVisit(env, v.id, log, provider(person(undefined)), ch);
    expect(r.outcome).toBe('resolved');
    expect(ch.sent).toHaveLength(1);
  });

  it('a California address from a visit with no known region is not delivered or stored as a lead, and is counted as out_of_state_address', async () => {
    const v = visit({ region: null, site_id: 'site_yardsign' });
    await insertVisit(env.DB, v);
    const ch = channel();
    const r = await processVisit(env, v.id, log, provider(person('CA')), ch);
    expect(r).toMatchObject({ outcome: 'withheld', skipReason: 'out_of_state_address' });
    expect(ch.sent).toHaveLength(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM leads').first<{ n: number }>()).toEqual({ n: 0 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM deliveries').first<{ n: number }>()).toEqual({ n: 0 });
    expect((await env.DB.prepare('SELECT skip_reason FROM visits WHERE id = ?').bind(v.id).first<{ skip_reason: string }>())?.skip_reason).toBe('out_of_state_address');
    const req = await env.DB.prepare('SELECT status, cost_cents, response_payload FROM identity_requests').first<{ status: string; cost_cents: number; response_payload: string }>();
    expect(req?.cost_cents).toBe(3); // billed, so it still counts toward the caps
    expect(JSON.parse(req!.response_payload).withheld).toBe('out_of_state_address');

    const st = await adminStats(env.DB);
    const row = st.explore.rows.find((r) => r[10] >= 0)!;
    expect(st.explore.dict.skip[row[10]]).toBe('Matched, lives outside Texas (not sent)');
  });

  it('no state on the record, from a visit with no known region, is not delivered', async () => {
    const v = visit({ region: null });
    await insertVisit(env.DB, v);
    const ch = channel();
    const r = await processVisit(env, v.id, log, provider(person(undefined)), ch);
    expect(r).toMatchObject({ outcome: 'withheld', skipReason: 'no_address_state' });
    expect(ch.sent).toHaveLength(0);
  });

  it('withheld answers lose their person fields after 30 days', async () => {
    const v = visit({ region: null });
    await insertVisit(env.DB, v);
    await processVisit(env, v.id, log, provider(person('CA')), channel());
    expect(await scrubWithheldResponses(env.DB)).toBe(0); // too new
    await env.DB.prepare('UPDATE identity_requests SET created_at = created_at - 31 * ?').bind(DAY_MS).run();
    expect(await scrubWithheldResponses(env.DB)).toBe(1);
    const req = await env.DB.prepare('SELECT response_payload FROM identity_requests').first<{ response_payload: string }>();
    expect(JSON.parse(req!.response_payload)).toEqual({ rows: 1, withheld: 'out_of_state_address', scrubbed: 1 });
    expect(req!.response_payload).not.toContain('Pat');
    expect(await scrubWithheldResponses(env.DB)).toBe(0); // once only
  });

  it('an opted-out person is never delivered, even with a Texas address', async () => {
    await optOut(env.DB, await hashEmail('gone@example.com'));
    const v = visit();
    await insertVisit(env.DB, v);
    const ch = channel();
    const r = await processVisit(env, v.id, log, provider(person('TX', 'gone@example.com')), ch);
    expect(r.outcome).toBe('opted_out');
    expect(ch.sent).toHaveLength(0);
  });

  it('ALLOWED_STATES = TX,OK delivers an Oklahoma visit with an Oklahoma address', async () => {
    const v = visit({ region: 'OK', city: 'Tulsa' });
    await insertVisit(env.DB, v);
    const blocked = await processVisit(env, v.id, log, provider(person('OK')), channel());
    expect(blocked).toMatchObject({ outcome: 'skipped', skipReason: 'not_allowed_state' });

    const v2 = visit({ region: 'OK', city: 'Tulsa' });
    await insertVisit(env.DB, v2);
    const ch = channel();
    const r = await processVisit({ ...env, ALLOWED_STATES: 'TX,OK' }, v2.id, log, provider(person('OK')), ch);
    expect(r.outcome).toBe('resolved');
    expect(ch.sent).toHaveLength(1);
  });
});

const PLANO_VISIT = (): NewVisit => ({
  id: '', site_id: SITE_ID, visitor_id: crypto.randomUUID(), session_id: 'sess_abcdefgh', url: 'http://localhost:3000/', path: '/',
  referrer: null, title: null, ip_hash: 'h', ip_raw: null, country: 'US', region: 'TX', city: 'Plano', postal: '75024', asn: 7018, colo: null,
  lat: null, lng: null, user_agent: 'Mozilla/5.0', device: '{}', screen: '{}', timezone: null, language: null, bot_score: null,
  occurred_at: Date.now(), created_at: Date.now(), gpc: 0, asn_org: 'AT&T', asn_class: 'residential',
});

describe('opt-out recall to roofers', () => {
  it('queues a recall for each lead before it is deleted', async () => {
    const hash = await hashEmail('sam@example.com');
    const v = { ...PLANO_VISIT(), id: crypto.randomUUID() };
    await insertVisit(env.DB, v);
    const sam: IdentityProvider = { name: 'fake', resolve: async () => ({ status: 'resolved', lead: { first_name: 'Sam', last_name: 'Example', state: 'TX', email: 'sam@example.com' }, raw: {} }) };
    const sent: LeadRow[] = [];
    expect((await processVisit(env, v.id, log, sam, { name: 'test', send: async (l: LeadRow) => void sent.push(l) })).outcome).toBe('resolved');
    const { deleted, recallIds } = await optOut(env.DB, hash);
    expect(deleted).toBe(1);
    const rows = await pendingRecalls(env.DB, { ids: recallIds });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.notify_email).toBeTruthy();
    const msg = recallMessage('Yardsign', rows, Date.UTC(2026, 9, 7));
    expect(msg.subject).toContain('2026-10-21'); // 10 business days after Wed Oct 7
    expect(msg.text).toContain('Sam Example');
    expect(msg.text).not.toMatch(/codename/i);
  });

  it('counts business days, skipping weekends', () => {
    expect(addBusinessDays(Date.UTC(2026, 9, 9), 1)).toBe('2026-10-12'); // Fri -> Mon
    expect(addBusinessDays(Date.UTC(2026, 9, 7), 10)).toBe('2026-10-21');
  });
});

describe('the public promises', () => {
  it('/privacy says Texas only and makes no cell, VPN, Private Relay, data center or California promise', async () => {
    const html = await (await app.fetch(new Request('http://localhost/privacy'), env)).text();
    expect(html).toContain('We only try to identify people in Texas: people whose home is in Texas, or who visit from Texas.');
    expect(html).toContain('we do not load our identity partner and we do not identify you');
    expect(html).toContain('within 10 business days');
    expect(html).toContain('[TX data broker registration no.]');
    expect(html).toContain('href="/optout"');
    const main = html.slice(0, html.indexOf('<footer'));
    for (const word of [/\bcell\b/i, /\bVPN/i, /Private Relay/i, /data center/i, /California/i, /codename/i]) expect(main, String(word)).not.toMatch(word);
  });

  it('the footer trust strip renders on public pages', async () => {
    const html = await (await app.fetch(new Request('http://localhost/privacy'), env)).text();
    expect(html).toContain('We honor Global Privacy Control · Texas homeowners only · opt-out deletes every lead');
  });

  it('the admin page shows the new reasons and visits by device', async () => {
    const now = Date.now();
    const add = (ua: string, reason: string | null) =>
      env.DB.prepare(
        `INSERT INTO visits (id, site_id, visitor_id, session_id, url, path, ip_hash, user_agent, device, screen, occurred_at, created_at, skip_reason)
         VALUES (?, ?, ?, 's', 'http://x/', '/', 'h', ?, '{}', '{}', ?, ?, ?)`,
      ).bind(crypto.randomUUID(), 'site_yardsign', crypto.randomUUID(), ua, now, now, reason);
    await env.DB.batch([add(IPHONE_UA, null), add(IPHONE_UA, 'gpc'), add(ANDROID_UA, 'not_allowed_state'), add('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'bot_or_datacenter')]);
    const st = await adminStats(env.DB);
    expect(st.explore.dict.skip.sort()).toEqual(['Bot or data center (cost filter)', 'Browser sent Global Privacy Control', 'Visit from outside Texas']);
    const devices = st.explore.rows.map((r) => r[4]).sort();
    expect(devices).toEqual([0, 0, 1, 2]); // iPhone, iPhone, Android, desktop
  });
});
