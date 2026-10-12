import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { deleteOldVisits, getSiteByKey, insertVisit, listRecentPathsForVisitor, type NewVisit } from '@yardsign/db';
import { MockProvider } from '@yardsign/identity';
import { app } from '../src/app';
import { createLogger } from '../src/log';
import { pruneRateLimits } from '../src/rate-limit';
import { processVisit } from '../src/resolution';
import { OTHER_SKIP_LABEL, siteStats, skipLabel } from '../src/stats';
import { SITE_ID, SITE_KEY, adminHeaders, postCollect, uuidFrom, viewPayload } from './helpers';

const log = createLogger({ req_id: 'test' });

async function dashKey(): Promise<string> {
  const site = await getSiteByKey(env.DB, SITE_KEY);
  return site!.dashKey!;
}

function visitRow(visitorId: string, over: Partial<NewVisit> = {}): NewVisit {
  return {
    id: crypto.randomUUID(), site_id: SITE_ID, visitor_id: visitorId, session_id: 'sess_abcdefgh', url: 'http://localhost:3000/roof-repair', path: '/roof-repair',
    referrer: null, title: null, ip_hash: 'h', ip_raw: null, country: 'US', region: 'TX', city: 'Plano', postal: '75024', asn: 7018, colo: null,
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

/**
 * `n` leads from `n` different visitors, one a minute apart going back from `now`, each with its visit
 * (path /p<i>), request and a delivered row. One batch, so it is fast. Returns the lead ids, newest first.
 */
async function seedLeads(n: number, now = Date.now()): Promise<string[]> {
  const stmts: D1PreparedStatement[] = [];
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const at = now - i * 60_000;
    const v = visitRow(uuidFrom(1000 + i), { path: `/p${i}`, url: `http://localhost:3000/p${i}`, occurred_at: at - 5000, created_at: at - 5000 });
    const reqId = crypto.randomUUID();
    const leadId = crypto.randomUUID();
    ids.push(leadId);
    stmts.push(
      env.DB.prepare('INSERT INTO visits (id, site_id, visitor_id, session_id, url, path, ip_hash, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(v.id, SITE_ID, v.visitor_id, v.session_id, v.url, v.path, 'h', v.occurred_at, v.created_at),
      env.DB.prepare("INSERT INTO identity_requests (id, visit_id, provider, status, created_at) VALUES (?, ?, 'mock', 'resolved', ?)").bind(reqId, v.id, at),
      env.DB.prepare("INSERT INTO leads (id, site_id, visitor_id, identity_request_id, first_name, last_name, state, confidence, created_at) VALUES (?, ?, ?, ?, 'Pat', ?, 'TX', 0.9, ?)").bind(leadId, SITE_ID, v.visitor_id, reqId, `Lead${i}`, at),
      env.DB.prepare("INSERT INTO deliveries (id, lead_id, channel, status, attempts, created_at) VALUES (?, ?, 'log', 'delivered', 1, ?)").bind(crypto.randomUUID(), leadId, at),
    );
  }
  await env.DB.batch(stmts);
  return ids;
}

describe('dashboard auth', () => {
  it('needs a dash key or the admin token', async () => {
    const login = await app.fetch(new Request('http://localhost/app'), env);
    expect(login.status).toBe(200); // no key: the login page, not the dashboard
    expect(await login.text()).toContain('Dashboard key');
    expect((await app.fetch(new Request('http://localhost/app?key='), env)).status).toBe(200);
    expect((await app.fetch(new Request('http://localhost/app?key=dk_0000000000000000000000'), env)).status).toBe(404);
    expect((await app.fetch(new Request(`http://localhost/app?key=${await dashKey()}`), env)).status).toBe(200);
    const admin = await app.fetch(new Request(`http://localhost/app?key=test-admin-token&site=${SITE_ID}`), env);
    expect(admin.status).toBe(200);
    expect(await admin.text()).toContain('<select name="site"');
    expect((await app.fetch(new Request('http://localhost/app/leads.json?key=test-admin-token'), env)).status).toBe(400); // admin must pick a site
  });

  it('every site gets a dash key, including ones made through the admin api', async () => {
    const res = await app.fetch(new Request('http://localhost:8787/api/admin/sites', { method: 'POST', headers: { ...adminHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ name: 'S', allowed_domains: ['s.com'] }) }), env);
    const body = await res.json<{ site: { dashKey: string; siteKey: string }; dashboard_url: string }>();
    expect(body.site.dashKey).toMatch(/^dk_[0-9a-f]{32}$/);
    expect(body.dashboard_url).toBe(`http://localhost:8787/app?key=${body.site.dashKey}`);
    const look = await app.fetch(new Request(`http://localhost:8787/api/admin/sites/${body.site.siteKey}/dashboard`, { headers: adminHeaders() }), env);
    expect((await look.json<{ dashboard_url: string }>()).dashboard_url).toBe(body.dashboard_url);
  });
});

describe('dashboard pages', () => {
  it('shows leads with pages and delivery status, and the feed matches', async () => {
    const vid = await resolvable();
    await insertVisit(env.DB, visitRow(vid, { path: '/financing', occurred_at: Date.now() - 1000 }));
    const v = visitRow(vid);
    await insertVisit(env.DB, v);
    const r = await processVisit(env, v.id, log);
    expect(r.outcome).toBe('resolved');

    const key = await dashKey();
    const page = await app.fetch(new Request(`http://localhost/app?key=${key}`), env);
    expect(page.status).toBe(200);
    expect(page.headers.get('cache-control')).toBe('no-store');
    const html = await page.text();
    expect(html).toContain('Test mode');
    expect(html).toContain('/roof-repair, /financing');
    expect(html).toContain('>delivered<');
    expect(html).toContain('Identified % of engaged');

    const feed = await app.fetch(new Request(`http://localhost/app/leads.json?key=${key}`), env);
    const body = await feed.json<{ mock: boolean; leads: Array<{ lead_id: string; pages: string[]; status: string; seen_at: number; first_name: string }> }>();
    expect(body.mock).toBe(true);
    expect(body.leads).toHaveLength(1);
    expect(body.leads[0]?.lead_id).toBe(r.leadId);
    expect(body.leads[0]?.pages).toEqual(['/roof-repair', '/financing']);
    expect(body.leads[0]?.status).toBe('delivered');
    const since = await app.fetch(new Request(`http://localhost/app/leads.json?key=${key}&since=${Date.now() + 1000}`), env);
    expect((await since.json<{ leads: unknown[] }>()).leads).toHaveLength(0);
  });

  it('install shows the tag and whether the pixel was seen', async () => {
    const key = await dashKey();
    let res = await app.fetch(new Request(`http://localhost:8787/app/install?key=${key}`), env);
    let html = await res.text();
    expect(html).toContain(`&lt;script async src=&quot;http://localhost:8787/p/${SITE_KEY}.js&quot;&gt;`);
    expect(html).toContain('No visits in the last 24 hours');
    expect(html).toContain('Global Privacy Control'); // the disclosure paragraph
    await (await postCollect(viewPayload())).ctx.settle();
    res = await app.fetch(new Request(`http://localhost:8787/app/install?key=${key}`), env);
    html = await res.text();
    expect(html).toContain('Pixel seen in the last 24 hours');
  });

  it('delivery form saves, validates, and sends a test lead through the channels', async () => {
    const key = await dashKey();
    const post = (b: Record<string, string>) => app.fetch(new Request(`http://localhost/app/delivery?key=${key}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(b) }), env);
    expect((await post({ lead_email: 'nope', action: 'save' })).status).toBe(400);
    expect((await post({ webhook_url: 'http://insecure.example.com/x', action: 'save' })).status).toBe(400);
    const saved = await post({ lead_email: 'Owner@Example.com', webhook_url: 'https://hooks.example.com/x', webhook_kind: 'slack', action: 'save' });
    expect(saved.status).toBe(200);
    expect(await saved.text()).toContain('Saved.');
    const site = await getSiteByKey(env.DB, SITE_KEY);
    expect(site?.leadEmail).toBe('owner@example.com');
    expect(site?.webhookKind).toBe('slack');
    const cleared = await post({ lead_email: '', webhook_url: '', action: 'save' });
    expect(await cleared.text()).toContain('Saved.');
    const test = await post({ lead_email: '', webhook_url: '', action: 'test' });
    expect(await test.text()).toContain('Add an email or a webhook first');
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM leads').first<{ n: number }>()).toEqual({ n: 0 });
  });

  it('sends at most 5 test leads an hour per site, and the cron cleanup keeps that count', async () => {
    const key = await dashKey();
    const post = () => app.fetch(new Request(`http://localhost/app/delivery?key=${key}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ lead_email: 'owner@example.com', action: 'test' }) }), env);
    for (let i = 0; i < 5; i++) {
      const r = await post();
      expect(r.status).toBe(200);
      // The test env has no EMAIL_API_KEY, so the send fails, and says so.
      expect(await r.text()).toContain('email: failed (email_not_configured)');
    }
    await pruneRateLimits(env.DB, Date.now() + 10 * 60_000); // the 5-minute cron, a few runs later
    const blocked = await post();
    expect(blocked.status).toBe(429);
    expect(await blocked.text()).toContain('5 test leads an hour');
  });

  it('print view is the clean stats page', async () => {
    const res = await app.fetch(new Request(`http://localhost/app?key=${await dashKey()}&print=1`), env);
    const html = await res.text();
    expect(html).toContain('last 30 days');
    expect(html).toContain('class="print"');
    expect(html).not.toContain('<table');
  });
});

describe('dashboard at scale', () => {
  it('renders /app and the feed with 150 leads from 150 visitors (D1 binds at most 100 values)', async () => {
    await seedLeads(150);
    const key = await dashKey();
    const page = await app.fetch(new Request(`http://localhost/app?key=${key}`), env);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Lead0');
    expect(html).toContain('Lead99'); // the page shows the newest 100
    expect(html).not.toContain('Lead100<');
    expect(html).toContain('>/p99<');

    const feed = await app.fetch(new Request(`http://localhost/app/leads.json?key=${key}`), env);
    expect(feed.status).toBe(200);
    const body = await feed.json<{ leads: Array<{ last_name: string; pages: string[]; status: string }> }>();
    expect(body.leads).toHaveLength(150);
    expect(body.leads[0]?.last_name).toBe('Lead0');
    expect(body.leads[149]?.pages).toEqual(['/p149']);
    expect(body.leads.every((l) => l.status === 'delivered')).toBe(true);
  });

  it('the feed pages oldest first after since, so more than 200 new leads are never skipped', async () => {
    const now = Date.now();
    await seedLeads(250, now); // Lead0 is newest, Lead249 oldest
    const key = await dashKey();
    type Feed = { now: number; next_since: number; has_more: boolean; leads: Array<{ last_name: string; seen_at: number }> };
    const poll = async (since: number) => (await app.fetch(new Request(`http://localhost/app/leads.json?key=${key}&since=${since}`), env)).json<Feed>();
    const first = await poll(0);
    expect(first.leads).toHaveLength(200);
    expect(first.has_more).toBe(true);
    expect(first.leads[0]?.last_name).toBe('Lead50'); // newest first within the page
    expect(first.leads[199]?.last_name).toBe('Lead249');
    expect(first.next_since).toBe(first.leads[0]?.seen_at);
    expect(first.now).toBeGreaterThanOrEqual(now);
    const second = await poll(first.next_since);
    expect(second.leads.map((l) => l.last_name)).toEqual(Array.from({ length: 50 }, (_, i) => `Lead${i}`));
    expect(second.has_more).toBe(false);
    const third = await poll(second.next_since);
    expect(third).toMatchObject({ leads: [], has_more: false, next_since: second.next_since });
  });

  it('never ends a feed page partway through leads that share a timestamp', async () => {
    const now = Date.now();
    await seedLeads(201, now);
    // Lead1 is the 200th oldest, the page edge. Give Lead0 the same millisecond.
    await env.DB.prepare("UPDATE leads SET created_at = ? WHERE last_name = 'Lead0'").bind(now - 60_000).run();
    const key = await dashKey();
    type Feed = { next_since: number; has_more: boolean; leads: Array<{ last_name: string }> };
    const poll = async (since: number) => (await app.fetch(new Request(`http://localhost/app/leads.json?key=${key}&since=${since}`), env)).json<Feed>();
    const first = await poll(0);
    expect(first.leads).toHaveLength(199);
    expect(first.has_more).toBe(true);
    const second = await poll(first.next_since);
    expect(second.leads.map((l) => l.last_name).sort()).toEqual(['Lead0', 'Lead1']);
  });

  it('an admin with a site id that matches nothing gets a 404, not another site', async () => {
    expect((await app.fetch(new Request('http://localhost/app/leads.json?key=test-admin-token&site=site_typo'), env)).status).toBe(404);
    const page = await app.fetch(new Request('http://localhost/app?key=test-admin-token&site=site_typo'), env);
    expect(page.status).toBe(404);
    expect(await page.text()).not.toContain('Test site (localhost)');
    expect((await app.fetch(new Request('http://localhost/app/leads.json?key=wrong-key&site=site_typo'), env)).status).toBe(401);
    expect((await app.fetch(new Request(`http://localhost/app/leads.json?key=test-admin-token&site=${SITE_ID}`), env)).status).toBe(200);
  });

  it('pages viewed are the week before the lead, not the week before today', async () => {
    const day = 24 * 3600 * 1000;
    const leadAt = Date.now() - 30 * day;
    await seedLeads(1, leadAt); // its visit is /p0, just before the lead
    const vid = uuidFrom(1000);
    await insertVisit(env.DB, visitRow(vid, { path: '/financing', occurred_at: leadAt - 2 * day }));
    await insertVisit(env.DB, visitRow(vid, { path: '/too-early', occurred_at: leadAt - 8 * day }));
    await insertVisit(env.DB, visitRow(vid, { path: '/came-back-today' })); // after the lead: not what led to it
    const body = await (await app.fetch(new Request(`http://localhost/app/leads.json?key=${await dashKey()}`), env)).json<{ leads: Array<{ pages: string[] }> }>();
    expect(body.leads[0]?.pages).toEqual(['/p0', '/financing']);
    expect(await listRecentPathsForVisitor(env.DB, SITE_ID, vid, 7 * day, leadAt)).toEqual(['/p0', '/financing']);
  });
});

describe('stats and retention', () => {
  it('counts engaged visitors by time on page or page count and skip reasons', async () => {
    await insertVisit(env.DB, visitRow(uuidFrom(1)));
    await insertVisit(env.DB, visitRow(uuidFrom(1), { path: '/b' }));
    await insertVisit(env.DB, visitRow(uuidFrom(2)));
    await env.DB.prepare('UPDATE visits SET time_on_page_ms = 15000 WHERE visitor_id = ?').bind(uuidFrom(2)).run();
    await insertVisit(env.DB, visitRow(uuidFrom(3)));
    await insertVisit(env.DB, visitRow(uuidFrom(4), { asn_class: 'mobile', asn_org: 'Verizon Wireless' }));
    await env.DB.prepare("UPDATE visits SET skip_reason = 'mobile', resolve_attempted_at = ? WHERE visitor_id = ?").bind(Date.now(), uuidFrom(4)).run();
    const st = await siteStats(env.DB, SITE_ID, 'acct_test');
    expect(st.visitors).toBe(4);
    expect(st.engaged).toBe(2);
    expect(st.skipped).toBe(1);
    expect(st.topReasons).toEqual([{ reason: 'cell data', n: 1 }]);
    expect(st.identified).toBe(0);
    expect(st.lastSeen).not.toBeNull();
  });

  it('identified % of engaged never passes 100: a lead from a one-page, 3-second visit is not engaged', async () => {
    await seedLeads(2); // two leads, each from a one-page visit with no time on page
    await env.DB.prepare('UPDATE visits SET time_on_page_ms = 3000').run();
    await insertVisit(env.DB, visitRow(uuidFrom(1001), { path: '/b' })); // the second lead's visitor saw 2 pages: engaged
    const st = await siteStats(env.DB, SITE_ID, 'acct_test');
    expect(st.identified).toBe(2);
    expect(st.engaged).toBe(1);
    expect(st.identifiedEngaged).toBe(1);
    expect(st.identifiedPct).toBe(100); // was 200
    const html = await (await app.fetch(new Request(`http://localhost/app?key=${await dashKey()}`), env)).text();
    expect(html).toContain('1 of 1 engaged visitors');
    expect(html).toContain('<div class="l">Identified % of engaged</div>');
  });

  it('labels every skip code in plain words and leaves our own limits out of "skipped on purpose"', async () => {
    const skip = async (n: number, reason: string) => {
      const v = visitRow(uuidFrom(n));
      await insertVisit(env.DB, v);
      await env.DB.prepare('UPDATE visits SET skip_reason = ?, resolve_attempted_at = ? WHERE id = ?').bind(reason, Date.now(), v.id).run();
    };
    for (const [i, r] of ['deduped_24h', 'deduped_30d', 'spend_cap', 'daily_spend_cap', 'spend_check_error', 'no_engagement', 'in_progress'].entries()) await skip(10 + i, r);
    expect((await siteStats(env.DB, SITE_ID, 'acct_test')).skipped).toBe(0);
    await skip(30, 'gpc');
    await skip(31, 'gpc');
    await skip(32, 'some_new_code');
    const st = await siteStats(env.DB, SITE_ID, 'acct_test');
    expect(st.skipped).toBe(3);
    expect(st.topReasons).toEqual([
      { reason: 'browser asked us not to', n: 2 },
      { reason: 'other reason', n: 1 },
    ]);
    for (const code of ['deduped_24h', 'no_engagement', 'spend_cap', 'daily_spend_cap', 'spend_check_error', 'over_quota', 'in_progress']) {
      expect(skipLabel(code), code).not.toBe(OTHER_SKIP_LABEL);
      expect(skipLabel(code), code).not.toContain('_');
    }
    expect(skipLabel('daily_spend_cap')).toBe('lookup paused');
    const html = await (await app.fetch(new Request(`http://localhost/app?key=${await dashKey()}`), env)).text();
    expect(html).not.toContain('some_new_code');
  });

  it('the stat tiles have styles', async () => {
    const css = await (await app.fetch(new Request('http://localhost/style.css'), env)).text();
    for (const rule of ['.tiles{', '.tile{', '.tile .l{', '.tile .n{', '.tile .s{']) expect(css, rule).toContain(rule);
  });

  it('deletes visits older than 13 months unless they led to a match', async () => {
    const old = Date.now() - 400 * 24 * 3600 * 1000;
    const vid = await resolvable();
    const matched = visitRow(vid, { created_at: old, occurred_at: old });
    const plain = visitRow(uuidFrom(50), { created_at: old, occurred_at: old });
    const fresh = visitRow(uuidFrom(51));
    for (const v of [matched, plain, fresh]) await insertVisit(env.DB, v);
    expect((await processVisit(env, matched.id, log)).outcome).toBe('resolved');
    expect(await deleteOldVisits(env.DB)).toBe(1);
    const left = (await env.DB.prepare('SELECT id FROM visits').all<{ id: string }>()).results.map((r) => r.id).sort();
    expect(left).toEqual([matched.id, fresh.id].sort());
  });
});
