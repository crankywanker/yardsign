import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { insertVisit, updateSiteDelivery, type DeliveryRow, type NewVisit, type Site } from '@yardsign/db';
import { MockProvider } from '@yardsign/identity';
import { EMAIL_NOT_CONFIGURED, EmailChannel, LogChannel, getDeliveryChannels, toLeadPayload } from '../src/delivery';
import { leadHtml, leadSubject, leadText } from '../src/email/lead-card';
import { PostmarkSender, ResendSender, getEmailSender, type EmailMessage, type EmailSender } from '../src/email/sender';
import { app } from '../src/app';
import { createLogger, type Logger } from '../src/log';
import { processVisit } from '../src/resolution';
import { SITE_ID, adminHeaders, uuidFrom } from './helpers';

const log = createLogger({ req_id: 'test' });

class FakeSender implements EmailSender {
  readonly name = 'fake';
  sent: EmailMessage[] = [];
  constructor(private readonly fail = false) {}
  async send(msg: EmailMessage): Promise<{ id: string | null }> {
    if (this.fail) throw new Error('fake: smtp down');
    this.sent.push(msg);
    return { id: `msg_${this.sent.length}` };
  }
}

const SAMPLE = toLeadPayload({
  id: 'lead_1', site_id: SITE_ID, visitor_id: uuidFrom(1), identity_request_id: 'req_1',
  first_name: 'Maria', last_name: 'Garcia', address_line1: '412 Example Ln', address_line2: null,
  city: 'Plano', state: 'TX', zip: '75024', phone: '(972) 555-0142', email: 'maria.garcia@example.com',
  confidence: 0.84, lat: null, lng: null, linkedin_url: null, email_hash: null, extra: '{"mock":true}', created_at: Date.UTC(2026, 9, 5, 15, 0, 0),
});

function visitRow(visitorId: string): NewVisit {
  return {
    id: crypto.randomUUID(), site_id: SITE_ID, visitor_id: visitorId, session_id: 'sess_abcdefgh', url: 'http://localhost:3000/roof-repair', path: '/roof-repair',
    referrer: null, title: null, ip_hash: 'h', ip_raw: null, country: 'US', region: 'TX', city: 'Plano', postal: '75024', asn: null, colo: null,
    lat: null, lng: null, user_agent: 'Mozilla/5.0', device: '{}', screen: '{}', timezone: null, language: null, bot_score: null,
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

describe('lead card', () => {
  const input = { payload: SAMPLE, siteName: 'Test Roofing', pages: ['/roof-repair', '/'], connection: { city: 'Plano', region: 'TX' }, mock: true };

  it('renders subject, text and html from the same data', () => {
    expect(leadSubject(input)).toBe('[TEST] New lead: Maria Garcia, Plano · Test Roofing');
    const text = leadText(input);
    expect(text).toContain('TEST LEAD');
    expect(text).toContain('412 Example Ln · Plano, TX · 75024');
    expect(text).toContain('(972) 555-0142');
    expect(text).toContain('High (84%)');
    expect(text).toContain('/roof-repair, /');
    const html = leadHtml(input);
    expect(html).toContain('Maria Garcia');
    expect(html).toContain('TEST LEAD');
    expect(html).toContain('tel:9725550142');
    expect(html).not.toMatch(/codename/i);
  });

  it('drops the banner and the [TEST] tag for a real provider', () => {
    const real = { ...input, mock: false };
    expect(leadSubject(real)).not.toContain('[TEST]');
    expect(leadText(real)).not.toContain('TEST LEAD');
    expect(leadHtml(real)).not.toContain('TEST LEAD');
  });

  it('labels an email-only match as a partial lead and says we keep looking', () => {
    const emailOnly = toLeadPayload({
      id: 'lead_2', site_id: SITE_ID, visitor_id: uuidFrom(2), identity_request_id: 'req_2',
      first_name: null, last_name: null, address_line1: null, address_line2: null, city: null, state: null, zip: null,
      phone: null, email: 'someone@example.com', confidence: 0.7, lat: null, lng: null, linkedin_url: null, email_hash: null, extra: '{}', created_at: Date.UTC(2026, 9, 7),
    });
    expect(SAMPLE.partial).toBe(false);
    expect(emailOnly.partial).toBe(true);
    const card = { ...input, mock: false, payload: emailOnly, recheckDays: 7 };
    expect(leadSubject(card)).toBe('Partial lead: someone@example.com · Test Roofing');
    expect(leadText(card)).toContain('Partial lead: we have an email, but no name or street address yet. If they come back to your site in the next 7 days, we look again and send a full card.');
    expect(leadHtml(card)).toContain('Partial lead · Test Roofing');
    expect(leadText(input)).not.toContain('Partial lead');
  });

  it('escapes html in lead fields', () => {
    const nasty = { ...input, payload: { ...SAMPLE, first_name: '<img src=x onerror=alert(1)>' } };
    expect(leadHtml(nasty)).not.toContain('<img');
    expect(leadHtml(nasty)).toContain('&lt;img');
  });
});

describe('email senders', () => {
  it('getEmailSender picks by env and fails loudly on bad config', () => {
    expect(getEmailSender({})).toBeNull();
    expect(getEmailSender({ EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 'k', EMAIL_FROM: 'a@b.co' })?.sender).toBeInstanceOf(ResendSender);
    expect(getEmailSender({ EMAIL_PROVIDER: 'postmark', EMAIL_API_KEY: 'k', EMAIL_FROM: 'a@b.co' })?.sender).toBeInstanceOf(PostmarkSender);
    expect(() => getEmailSender({ EMAIL_PROVIDER: 'resend' })).toThrow(/EMAIL_API_KEY/);
    expect(() => getEmailSender({ EMAIL_PROVIDER: 'ses', EMAIL_API_KEY: 'k', EMAIL_FROM: 'a@b.co' })).toThrow(/Unknown EMAIL_PROVIDER/);
  });

  it('resend sender posts the expected body and surfaces API errors', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const ok: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ id: 'em_123' }), { status: 200 });
    };
    const r = await new ResendSender('key', ok).send({ to: 'a@b.co', from: 'Yardsign <l@t.co>', subject: 's', html: '<p>h</p>', text: 't' });
    expect(r.id).toBe('em_123');
    expect(calls[0]?.url).toBe('https://api.resend.com/emails');
    expect(JSON.parse(String(calls[0]?.init.body)).to).toEqual(['a@b.co']);
    const bad: typeof fetch = async () => new Response('{"message":"invalid key"}', { status: 401, statusText: 'Unauthorized' });
    await expect(new ResendSender('key', bad).send({ to: 'a@b.co', from: 'f', subject: 's', html: 'h', text: 't' })).rejects.toThrow(/401/);
  });
});

describe('email delivery in the resolution step', () => {
  it('uses the log channel only when the site has no lead_email and no webhook', async () => {
    const siteNoEmail: Site = { id: SITE_ID, accountId: 'a', siteKey: 'TESTKEY', name: 'T', allowedDomains: [], active: true, leadEmail: null, webhookUrl: null, webhookKind: null, stripeSessionId: null, dashKey: null, delivrPixelId: null, pixelSeenAt: null, reviewReason: null, createdAt: 0 };
    const names = (site: Site, e: Parameters<typeof getDeliveryChannels>[0] = {}) => getDeliveryChannels(e, env.DB, site, { city: null, region: null }, 'mock', log).map((ch) => ch.name);
    expect(names(siteNoEmail)).toEqual(['log']);
    const siteEmail = { ...siteNoEmail, leadEmail: 'owner@example.com' };
    expect(names(siteEmail)).toEqual(['email']); // email not set up: still the email channel, and every send fails
    expect(names(siteEmail, { EMAIL_PROVIDER: 'resend' })).toEqual(['email']); // misconfigured: same
    expect(names(siteEmail, { EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 'k', EMAIL_FROM: 'l@t.co' })).toEqual(['email']);
    const both = { ...siteEmail, webhookUrl: 'https://hooks.example.com/x', webhookKind: 'slack' as const };
    expect(names(both, { EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 'k', EMAIL_FROM: 'l@t.co' })).toEqual(['email', 'webhook:slack']);
    expect(names({ ...siteNoEmail, webhookUrl: 'https://hooks.example.com/x', webhookKind: null })).toEqual(['webhook:json']);
  });

  it('emails the card and records the delivery', async () => {
    await updateSiteDelivery(env.DB, SITE_ID, { leadEmail: 'owner@example.com', webhookUrl: null, webhookKind: null });
    const vid = await resolvableVisitorId();
    const v = visitRow(vid);
    await insertVisit(env.DB, v);
    const sender = new FakeSender();
    const channel = new EmailChannel({
      sender, from: 'Yardsign <leads@tryyardsign.com>', to: 'owner@example.com', siteName: 'Test Roofing',
      context: async () => ({ pages: ['/roof-repair'], connection: { city: 'Plano', region: 'TX' }, mock: true }),
    });
    const r = await processVisit(env, v.id, log, new MockProvider(), channel);
    expect(r.outcome).toBe('resolved');
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.to).toBe('owner@example.com');
    expect(sender.sent[0]?.subject).toMatch(/^\[TEST\] New lead: /);
    const d = await env.DB.prepare('SELECT * FROM deliveries WHERE lead_id = ?').bind(r.leadId).first<DeliveryRow>();
    expect(d?.channel).toBe('email');
    expect(d?.status).toBe('delivered');
    expect(d?.attempts).toBe(1);
  });

  // wrangler.toml sets EMAIL_PROVIDER and the tests have no EMAIL_API_KEY: a broken setup. Then no provider at all.
  it.each([
    ['EMAIL_API_KEY missing', {}],
    ['EMAIL_PROVIDER unset', { EMAIL_PROVIDER: '' }],
  ])('records a failed email delivery, never "delivered", when the site has a lead email but email is not set up (%s)', async (_label, over) => {
    await updateSiteDelivery(env.DB, SITE_ID, { leadEmail: 'owner@example.com', webhookUrl: null, webhookKind: null });
    const v = visitRow(await resolvableVisitorId());
    await insertVisit(env.DB, v);
    const r = await processVisit({ ...env, ...over }, v.id, log, new MockProvider());
    expect(r.outcome).toBe('resolved');
    const rows = (await env.DB.prepare('SELECT * FROM deliveries WHERE lead_id = ?').bind(r.leadId).all<DeliveryRow>()).results;
    expect(rows.map((d) => [d.channel, d.status, d.last_error])).toEqual([['email', 'failed', EMAIL_NOT_CONFIGURED]]);
  });

  it('the log channel writes the lead and site ids, never the person', async () => {
    const lines: string[] = [];
    const capture: Logger = {
      info: (msg, f) => void lines.push(JSON.stringify({ msg, ...f })),
      warn: (msg, f) => void lines.push(JSON.stringify({ msg, ...f })),
      error: (msg, f) => void lines.push(JSON.stringify({ msg, ...f })),
      child: () => capture,
    };
    await new LogChannel().send({} as never, SAMPLE, capture);
    const out = lines.join('\n');
    expect(out).toContain('lead_1');
    expect(out).toContain(SITE_ID);
    for (const pii of ['Maria', 'Garcia', '412 Example Ln', '555-0142', 'maria.garcia@example.com', '75024']) expect(out).not.toContain(pii);
  });

  it('records a failed delivery without losing the lead', async () => {
    const vid = await resolvableVisitorId();
    const v = visitRow(vid);
    await insertVisit(env.DB, v);
    const channel = new EmailChannel({
      sender: new FakeSender(true), from: 'f', to: 'owner@example.com', siteName: 'T',
      context: async () => ({ pages: [], connection: null, mock: true }),
    });
    const r = await processVisit(env, v.id, log, new MockProvider(), channel);
    expect(r.outcome).toBe('resolved');
    const d = await env.DB.prepare('SELECT * FROM deliveries WHERE lead_id = ?').bind(r.leadId).first<DeliveryRow>();
    expect(d?.status).toBe('failed');
    expect(d?.last_error).toContain('smtp down');
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM leads').first<{ n: number }>()).toEqual({ n: 1 });
  });
});

describe('admin sites', () => {
  it('creates a site, lists it, and sets delivery', async () => {
    const res = await app.fetch(new Request('http://localhost:8787/api/admin/sites', { method: 'POST', headers: { ...adminHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Second Site', allowed_domains: ['Example.com'], lead_email: 'Her@Example.com' }) }), env);
    expect(res.status).toBe(201);
    const body = await res.json<{ site: { siteKey: string; allowedDomains: string[]; leadEmail: string }; install_tag: string }>();
    expect(body.site.siteKey).toMatch(/^[A-Z2-9]{12}$/);
    expect(body.site.allowedDomains).toEqual(['example.com']);
    expect(body.site.leadEmail).toBe('her@example.com');
    expect(body.install_tag).toBe(`<script async src="http://localhost:8787/p/${body.site.siteKey}.js"></script>`);

    const list = await app.fetch(new Request('http://localhost/api/admin/sites', { headers: adminHeaders() }), env);
    expect((await list.json<{ count: number }>()).count).toBe(3); // seed test site + tryyardsign.com + this one

    const put = await app.fetch(new Request(`http://localhost/api/admin/sites/${body.site.siteKey}/delivery`, { method: 'PUT', headers: { ...adminHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ lead_email: null, webhook_url: 'https://hooks.slack.com/services/T/B/x', webhook_kind: 'slack' }) }), env);
    const putBody = await put.json<{ lead_email: string | null; webhook_url: string | null; webhook_kind: string | null }>();
    expect(putBody.lead_email).toBeNull();
    expect(putBody.webhook_url).toBe('https://hooks.slack.com/services/T/B/x');
    expect(putBody.webhook_kind).toBe('slack');
    const bad = await app.fetch(new Request(`http://localhost/api/admin/sites/${body.site.siteKey}/delivery`, { method: 'PUT', headers: { ...adminHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ webhook_url: 'http://localhost:8787/collect' }) }), env);
    expect(bad.status).toBe(400);
  });

  it('rejects bad input', async () => {
    const post = (b: unknown) => app.fetch(new Request('http://localhost/api/admin/sites', { method: 'POST', headers: { ...adminHeaders(), 'content-type': 'application/json' }, body: JSON.stringify(b) }), env);
    expect((await post({ name: 'x', allowed_domains: [] })).status).toBe(400);
    expect((await post({ name: 'x', allowed_domains: ['not a host'] })).status).toBe(400);
    expect((await post({ name: 'x', allowed_domains: ['a.com'], lead_email: 'nope' })).status).toBe(400);
    expect((await post({ name: 'x', allowed_domains: ['a.com'], site_key: 'TESTKEY' })).status).toBe(409);
    expect((await app.fetch(new Request('http://localhost/api/admin/sites', { method: 'POST', body: '{}' }), env)).status).toBe(401);
  });
});

describe('POST /api/admin/email/test', () => {
  const post = (body: unknown, extraEnv: Record<string, string> = {}) =>
    app.request('/api/admin/email/test', { method: 'POST', headers: { ...adminHeaders(), 'content-type': 'application/json' }, body: JSON.stringify(body) }, { ...env, ...extraEnv });

  it('needs the admin token', async () => {
    const res = await app.request('/api/admin/email/test', { method: 'POST', body: '{}' }, env);
    expect(res.status).toBe(401);
  });

  it('rejects a bad address', async () => {
    const res = await post({ to: 'not-an-email' });
    expect(res.status).toBe(400);
  });

  it('says so when email is not configured', async () => {
    const res = await post({ to: 'owner@example.com' }, { EMAIL_PROVIDER: '' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/EMAIL_PROVIDER/);
  });

  it('reports a misconfigured provider instead of crashing', async () => {
    const res = await post({ to: 'owner@example.com' }, { EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: '', EMAIL_FROM: 'Yardsign <leads@mail.tryyardsign.com>' });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toMatch(/EMAIL_API_KEY/);
  });
});

describe('senders call the global fetch safely', () => {
  // Storing `fetch` as a field and calling `this.fetchFn(...)` makes Workers throw "Illegal invocation"
  // because `this` is the sender, not the global. The default must call the global fetch at call time.
  it('ResendSender and PostmarkSender work with the default fetch', async () => {
    // Build the senders first, so a sender that captured the real fetch at construction is caught.
    const resend = new ResendSender('k');
    const postmark = new PostmarkSender('k');
    const orig = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ id: 'r1', MessageID: 'p1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const msg: EmailMessage = { to: 'a@b.co', from: 'c@d.co', subject: 's', html: '<p>h</p>', text: 't' };
      expect(await resend.send(msg)).toEqual({ id: 'r1' });
      expect(await postmark.send(msg)).toEqual({ id: 'p1' });
      expect(seen).toEqual(['https://api.resend.com/emails', 'https://api.postmarkapp.com/email']);
    } finally {
      globalThis.fetch = orig;
    }
  });
});
