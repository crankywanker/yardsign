import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import { countAccountLeadsSince, getAccountByEmail, getSiteByStripeSession, insertSite, insertVisit, type AccountRow, type DeliveryRow, type NewVisit, type SiteRow } from '@yardsign/db';
import { MockProvider, type IdentityProvider, type ResolveResult } from '@yardsign/identity';
import { app } from '../src/app';
import { REVIEW_OTHER_CUSTOMER, cleanDomain, createCheckout, handleStripeWebhook, provision, stripeConfigured, type CheckoutLike } from '../src/billing';
import { createLogger } from '../src/log';
import { PLANS } from '../src/plans';
import { processVisit } from '../src/resolution';
import { SITE_ID, uuidFrom } from './helpers';

const log = createLogger({ req_id: 'test' });
const STRIPE_ENV = { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test_secret', STRIPE_PRICE_STARTER: 'price_starter', STRIPE_PRICE_PRO: 'price_pro' };

function session(over: Partial<CheckoutLike> = {}): CheckoutLike {
  return {
    id: 'cs_test_abc123',
    status: 'complete',
    mode: 'subscription',
    payment_status: 'paid',
    customer_details: { email: 'Owner@AcmeRoofing.com' },
    customer: 'cus_123',
    subscription: 'sub_123',
    metadata: { plan: 'pro', domain: 'https://www.AcmeRoofing.com/' },
    ...over,
  };
}

const siteRow = (sessionId: string) => env.DB.prepare('SELECT * FROM sites WHERE stripe_session_id = ?').bind(sessionId).first<SiteRow>();

/** An account someone already has, with its own Stripe customer and an unlimited quota. */
async function existingAccount(customer: string | null = 'cus_owner'): Promise<AccountRow> {
  await env.DB.prepare(
    "INSERT INTO accounts (id, name, email, plan, stripe_customer_id, stripe_subscription_id, monthly_quota, status, created_at) VALUES ('acct_owner', 'Acme', 'owner@acmeroofing.com', 'pro', ?, ?, 0, 'active', 1)",
  )
    .bind(customer, customer ? 'sub_owner' : null)
    .run();
  await insertSite(env.DB, { accountId: 'acct_owner', siteKey: 'OWNERSITE01', name: 'acmeroofing.com', allowedDomains: ['acmeroofing.com'], leadEmail: 'owner@acmeroofing.com' });
  return (await getAccountByEmail(env.DB, 'owner@acmeroofing.com'))!;
}

describe('cleanDomain', () => {
  it('normalizes what people type', () => {
    expect(cleanDomain('https://www.AcmeRoofing.com/path?x')).toBe('acmeroofing.com');
    expect(cleanDomain('  acmeroofing.com ')).toBe('acmeroofing.com');
  });
});

describe('provision', () => {
  afterEach(() => vi.restoreAllMocks());

  it('creates the account and site once, idempotent on the session id', async () => {
    const dbEnv = { DB: env.DB, ...STRIPE_ENV };
    const site = await provision(dbEnv, session());
    expect(site).not.toBeNull();
    expect(site?.active).toBe(true);
    expect(site?.reviewReason).toBeNull();
    expect(site?.allowedDomains).toEqual(['acmeroofing.com']);
    expect(site?.leadEmail).toBe('owner@acmeroofing.com');
    expect(site?.siteKey).toMatch(/^[A-Z2-9]{12}$/);
    expect((await siteRow('cs_test_abc123'))?.stripe_subscription_id).toBe('sub_123');
    const account = await getAccountByEmail(env.DB, 'owner@acmeroofing.com');
    expect(account?.plan).toBe('pro');
    expect(account?.monthly_quota).toBe(PLANS.pro.quota);
    expect(account?.stripe_customer_id).toBe('cus_123');

    const again = await provision(dbEnv, session());
    expect(again?.id).toBe(site?.id);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sites WHERE stripe_session_id = 'cs_test_abc123'").first<{ n: number }>()).toEqual({ n: 1 });
  });

  it('only provisions a finished, paid subscription for a plan we sell', async () => {
    const dbEnv = { DB: env.DB, ...STRIPE_ENV };
    expect(await provision(dbEnv, session({ status: 'open' }))).toBeNull();
    expect(await provision(dbEnv, session({ mode: 'payment' }))).toBeNull();
    expect(await provision(dbEnv, session({ payment_status: 'unpaid' }))).toBeNull(); // a bank payment still clearing
    expect(await provision(dbEnv, session({ metadata: { plan: 'enterprise', domain: 'acmeroofing.com' } }))).toBeNull();
    expect(await provision(dbEnv, session({ metadata: { domain: 'acmeroofing.com' } }))).toBeNull();
    expect(await getAccountByEmail(env.DB, 'owner@acmeroofing.com')).toBeNull();
    // A 100%-off promotion code needs no payment, and is a real purchase.
    expect((await provision(dbEnv, session({ payment_status: 'no_payment_required' })))?.active).toBe(true);
  });

  it('adds a second site for the same Stripe customer and never changes the account', async () => {
    const dbEnv = { DB: env.DB, ...STRIPE_ENV };
    await provision(dbEnv, session());
    await env.DB.prepare("UPDATE accounts SET status = 'suspended' WHERE email = 'owner@acmeroofing.com'").run();
    const before = await getAccountByEmail(env.DB, 'owner@acmeroofing.com');
    const second = await provision(dbEnv, session({ id: 'cs_test_second', subscription: 'sub_456', metadata: { plan: 'starter', domain: 'second.com' } }));
    expect(second?.allowedDomains).toEqual(['second.com']);
    expect(second?.active).toBe(true);
    expect(second?.accountId).toBe(before?.id);
    expect((await siteRow('cs_test_second'))?.stripe_subscription_id).toBe('sub_456');
    // A Starter purchase does not downgrade Pro, does not re-activate, does not swap the Stripe ids.
    expect(await getAccountByEmail(env.DB, 'owner@acmeroofing.com')).toEqual(before);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM sites WHERE account_id = ?').bind(before?.id).first<{ n: number }>()).toEqual({ n: 2 });
  });

  it("a checkout with someone else's email leaves their account alone, creates the site off, and emails the operator", async () => {
    const before = await existingAccount();
    const sent: Array<{ to: string[]; subject: string; text: string }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      expect(String(input)).toBe('https://api.resend.com/emails');
      sent.push(JSON.parse(String((init as RequestInit).body)) as { to: string[]; subject: string; text: string });
      return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 });
    });
    const opsEnv = { DB: env.DB, ...STRIPE_ENV, EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 'k', EMAIL_FROM: 'Yardsign <leads@example.com>', SPEND_ALERT_EMAIL: 'ops@example.com' };
    const site = await provision(opsEnv, session({ customer: 'cus_stranger', subscription: 'sub_stranger', metadata: { plan: 'starter', domain: 'stranger.example' } }));
    expect(site).toMatchObject({ accountId: 'acct_owner', active: false, reviewReason: REVIEW_OTHER_CUSTOMER, allowedDomains: ['stranger.example'] });
    expect(await getAccountByEmail(env.DB, 'owner@acmeroofing.com')).toEqual(before);
    expect(await env.DB.prepare("SELECT active FROM sites WHERE site_key = 'OWNERSITE01'").first()).toEqual({ active: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toEqual(['ops@example.com']);
    expect(sent[0]?.subject).toContain('needs your review');
    expect(sent[0]?.text).toContain('cus_stranger');
    expect(sent[0]?.text).toContain(site?.siteKey);

    // Provisioning the same session again (the webhook after /welcome) sends nothing more.
    expect((await provision(opsEnv, session({ customer: 'cus_stranger', subscription: 'sub_stranger' })))?.id).toBe(site?.id);
    expect(sent).toHaveLength(1);

    // The buyer's welcome page says setup finishes by email, and shows no tag and no dashboard key.
    const res = await app.fetch(new Request('http://localhost/welcome?session_id=cs_test_abc123'), { ...env, ...STRIPE_ENV });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('finish setting up your account by hand');
    expect(html).not.toContain(site?.dashKey ?? 'dk_');
    expect(html).not.toContain('/p/');
  });

  it('an existing account with no Stripe customer (made by hand) is never matched', async () => {
    await existingAccount(null);
    expect((await provision({ DB: env.DB, ...STRIPE_ENV }, session({ customer: null })))?.reviewReason).toBe(REVIEW_OTHER_CUSTOMER);
    expect((await provision({ DB: env.DB, ...STRIPE_ENV }, session({ id: 'cs_test_two', customer: 'cus_new' })))?.reviewReason).toBe(REVIEW_OTHER_CUSTOMER);
  });

  it('two runs of the same session at once make one account and one site', async () => {
    const dbEnv = { DB: env.DB, ...STRIPE_ENV };
    const [a, b] = await Promise.all([provision(dbEnv, session()), provision(dbEnv, session())]);
    expect(a?.id).toBe(b?.id);
    expect(a?.active && b?.active).toBe(true);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM accounts WHERE email = 'owner@acmeroofing.com'").first()).toEqual({ n: 1 });
  });

  it('only a lost race on the session id is swallowed; any other insert error surfaces', async () => {
    await env.DB.prepare("CREATE TRIGGER fail_site_insert BEFORE INSERT ON sites BEGIN SELECT RAISE(ABORT, 'disk on fire'); END").run();
    try {
      await expect(provision({ DB: env.DB, ...STRIPE_ENV }, session())).rejects.toThrow(/disk on fire/);
    } finally {
      await env.DB.prepare('DROP TRIGGER fail_site_insert').run();
    }
  });
});

describe('createCheckout', () => {
  it('posts a subscription session to Stripe and returns its url', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fakeFetch: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), body: String(init?.body) });
      return new Response(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const url = await createCheckout({ DB: env.DB, ...STRIPE_ENV }, 'pro', 'owner@acmeroofing.com', 'acmeroofing.com', 'https://tryyardsign.com', fakeFetch);
    expect(url).toBe('https://checkout.stripe.com/c/pay/cs_test_1');
    expect(calls[0]?.url).toContain('/v1/checkout/sessions');
    const body = decodeURIComponent(calls[0]?.body ?? '');
    expect(body).toContain('mode=subscription');
    expect(body).toContain('line_items[0][price]=price_pro');
    expect(body).toContain('metadata[domain]=acmeroofing.com');
    expect(body).toContain('success_url=https://tryyardsign.com/welcome?session_id={CHECKOUT_SESSION_ID}');
  });
});

describe('stripe webhook', () => {
  async function signed(payload: object): Promise<{ body: string; sig: string }> {
    const body = JSON.stringify(payload);
    const stripe = new Stripe('sk_test_x', { httpClient: Stripe.createFetchHttpClient() });
    const sig = await stripe.webhooks.generateTestHeaderStringAsync({ payload: body, secret: STRIPE_ENV.STRIPE_WEBHOOK_SECRET, cryptoProvider: Stripe.createSubtleCryptoProvider() });
    return { body, sig };
  }
  async function post(type: string, object: object, id = crypto.randomUUID()): Promise<Response> {
    const { body, sig } = await signed({ id: `evt_${id}`, type, data: { object } });
    return app.fetch(new Request('http://localhost/stripe/webhook', { method: 'POST', headers: { 'stripe-signature': sig }, body }), { ...env, ...STRIPE_ENV });
  }

  it('rejects a bad signature and refuses when unconfigured', async () => {
    const r = await handleStripeWebhook({ DB: env.DB, ...STRIPE_ENV }, '{}', 't=1,v1=bad');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
    const u = await handleStripeWebhook({ DB: env.DB }, '{}', '');
    if (!u.ok) expect(u.status).toBe(503);
    const res = await app.fetch(new Request('http://localhost/stripe/webhook', { method: 'POST', body: '{}' }), { ...env, ...STRIPE_ENV });
    expect(res.status).toBe(400);
  });

  it('provisions on checkout.session.completed; a cancelled subscription turns off only its own site', async () => {
    expect((await post('checkout.session.completed', session())).status).toBe(200);
    expect((await post('checkout.session.completed', session({ id: 'cs_test_second', subscription: 'sub_456', metadata: { plan: 'pro', domain: 'second.com' } }))).status).toBe(200);
    expect((await post('customer.subscription.deleted', { id: 'sub_123' })).status).toBe(200);
    expect((await siteRow('cs_test_abc123'))?.active).toBe(0);
    expect((await siteRow('cs_test_second'))?.active).toBe(1);
    expect((await getAccountByEmail(env.DB, 'owner@acmeroofing.com'))?.status).toBe('active');
  });

  it("a stranger's cancellation never touches the real owner's sites", async () => {
    await existingAccount();
    await post('checkout.session.completed', session({ customer: 'cus_stranger', subscription: 'sub_stranger' }));
    expect((await siteRow('cs_test_abc123'))?.review_reason).toBe(REVIEW_OTHER_CUSTOMER);
    // Their card is disputed and the subscription ends: only the site they paid for is affected.
    await post('customer.subscription.deleted', { id: 'sub_stranger' });
    expect(await env.DB.prepare("SELECT active FROM sites WHERE site_key = 'OWNERSITE01'").first()).toEqual({ active: 1 });
    expect((await getAccountByEmail(env.DB, 'owner@acmeroofing.com'))?.status).toBe('active');
  });

  it('waits for a delayed payment, then provisions on checkout.session.async_payment_succeeded', async () => {
    await post('checkout.session.completed', session({ payment_status: 'unpaid' }));
    expect(await getSiteByStripeSession(env.DB, 'cs_test_abc123')).toBeNull();
    expect((await post('checkout.session.async_payment_succeeded', session())).status).toBe(200);
    expect((await getSiteByStripeSession(env.DB, 'cs_test_abc123'))?.active).toBe(true);
  });
});

describe('checkout and welcome routes', () => {
  afterEach(() => vi.restoreAllMocks());

  it('validates the form and is honest when Stripe is not configured', async () => {
    const post = (b: Record<string, string>, e = env) => app.fetch(new Request('http://localhost/checkout', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(b) }), e);
    expect((await post({ plan: 'pro', email: 'nope', domain: 'a.com' })).status).toBe(400);
    expect((await post({ plan: 'pro', email: 'a@b.co', domain: 'nope' })).status).toBe(400);
    const r = await post({ plan: 'pro', email: 'a@b.co', domain: 'acme.com' });
    expect(r.status).toBe(503);
    expect(await r.text()).toContain('not taking payments yet');
  });

  it('checkout stays off without the webhook secret', async () => {
    const { STRIPE_WEBHOOK_SECRET: _omit, ...noWebhook } = STRIPE_ENV;
    expect(stripeConfigured({ DB: env.DB, ...STRIPE_ENV })).toBe(true);
    expect(stripeConfigured({ DB: env.DB, ...noWebhook })).toBe(false);
    const r = await app.fetch(
      new Request('http://localhost/checkout', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ plan: 'pro', email: 'a@b.co', domain: 'acme.com' }) }),
      { ...env, ...noWebhook },
    );
    expect(r.status).toBe(503);
  });

  it('welcome rejects a bad session id', async () => {
    expect((await app.fetch(new Request('http://localhost/welcome?session_id=evil'), env)).status).toBe(400);
    expect((await app.fetch(new Request('http://localhost/welcome?session_id=cs_test_1'), env)).status).toBe(503);
  });

  it('welcome: an expired checkout is an error, a pending one reloads for about 2 minutes and then stops', async () => {
    let status = 'expired';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      expect(String(input)).toContain('/v1/checkout/sessions/cs_test_wait');
      return new Response(JSON.stringify({ id: 'cs_test_wait', object: 'checkout.session', status, mode: 'subscription', payment_status: 'unpaid' }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const get = (q = '') => app.fetch(new Request(`http://localhost/welcome?session_id=cs_test_wait${q}`), { ...env, ...STRIPE_ENV });
    const expired = await get();
    expect(expired.status).toBe(410);
    expect(await expired.text()).toContain('expired');
    status = 'open';
    const first = await (await get()).text();
    expect(first).toContain('http-equiv="refresh"');
    expect(first).toContain('session_id=cs_test_wait&amp;n=1');
    const last = await (await get('&n=24')).text();
    expect(last).not.toContain('http-equiv="refresh"');
    expect(last).toContain('still processing');
  });

  it('checkout and welcome are rate limited per IP', async () => {
    const checkout = () => app.fetch(new Request('http://localhost/checkout', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': '203.0.113.7' }, body: new URLSearchParams({ email: 'nope' }) }), env);
    for (let i = 0; i < 10; i++) expect((await checkout()).status).toBe(400);
    expect((await checkout()).status).toBe(429);
    const welcome = (ip: string) => app.fetch(new Request('http://localhost/welcome?session_id=cs_test_1', { headers: { 'cf-connecting-ip': ip } }), env);
    for (let i = 0; i < 20; i++) expect((await welcome('203.0.113.8')).status).toBe(503); // Stripe is off in the test env
    expect((await welcome('203.0.113.8')).status).toBe(429);
    expect((await welcome('203.0.113.9')).status).toBe(503); // another visitor is fine
  });
});

describe('account status and quota in the resolution step', () => {
  function visitRow(visitorId: string): NewVisit {
    return {
      id: crypto.randomUUID(), site_id: SITE_ID, visitor_id: visitorId, session_id: 'sess_abcdefgh', url: 'http://localhost:3000/', path: '/',
      referrer: null, title: null, ip_hash: 'h', ip_raw: null, country: 'US', region: 'TX', city: 'Plano', postal: '75024', asn: 7018, colo: null,
      lat: null, lng: null, user_agent: 'Mozilla/5.0', device: '{}', screen: '{}', timezone: null, language: null, bot_score: null,
      occurred_at: Date.now(), created_at: Date.now(), gpc: 0, asn_org: 'AT&T', asn_class: 'residential',
    };
  }
  async function resolvableIds(n: number): Promise<string[]> {
    const p = new MockProvider();
    const out: string[] = [];
    for (let i = 0; i < 2000 && out.length < n; i++) {
      const vid = uuidFrom(i);
      const r = await p.resolve({ visitor_id: vid, visit_id: 'x', site_id: SITE_ID, ip: null, ip_hash: 'h', user_agent: null, geo: { country: null, region: null, city: null, postal: null, lat: null, lng: null, asn: null }, occurred_at: 0, created_at: 0 });
      if (r.status === 'resolved') out.push(vid);
    }
    return out;
  }

  it('skips suspended accounts without calling the provider', async () => {
    await env.DB.prepare("UPDATE accounts SET status = 'suspended' WHERE id = 'acct_test'").run();
    const [vid] = await resolvableIds(1);
    const v = visitRow(vid!);
    await insertVisit(env.DB, v);
    const r = await processVisit(env, v.id, log);
    expect(r).toMatchObject({ outcome: 'skipped', skipReason: 'account_suspended' });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM identity_requests').first<{ n: number }>()).toEqual({ n: 0 });
  });

  /** A real (not mock) provider that finds a Texas household every time. `paid` makes the spend rules apply. */
  function stubProvider(paid = false): IdentityProvider & { calls: number } {
    const p = {
      name: paid ? 'delivr' : 'stub',
      ...(paid ? { maxCostCentsPerCall: 2.5 } : {}),
      calls: 0,
      async resolve(): Promise<ResolveResult> {
        p.calls++;
        return { status: 'resolved', confidence: 0.9, cost_cents: paid ? 2.5 : 0, lead: { first_name: 'Ann', last_name: 'Lee', address_line1: '1 Main St', city: 'Plano', state: 'TX', zip: '75024' } };
      },
    };
    return p;
  }

  it('keeps the lead but skips delivery once the monthly quota is used up', async () => {
    await env.DB.prepare("UPDATE accounts SET monthly_quota = 1 WHERE id = 'acct_test'").run();
    const first = visitRow(uuidFrom(1));
    const second = visitRow(uuidFrom(2));
    await insertVisit(env.DB, first);
    await insertVisit(env.DB, second);
    const stub = stubProvider();
    const r1 = await processVisit(env, first.id, log, stub);
    const r2 = await processVisit(env, second.id, log, stub);
    expect(r1.outcome).toBe('resolved');
    expect(r2.outcome).toBe('resolved');
    const d1 = await env.DB.prepare('SELECT * FROM deliveries WHERE lead_id = ?').bind(r1.leadId).first<DeliveryRow>();
    const d2 = await env.DB.prepare('SELECT * FROM deliveries WHERE lead_id = ?').bind(r2.leadId).first<DeliveryRow>();
    expect(d1?.status).toBe('delivered');
    expect(d2?.status).toBe('skipped');
    expect(d2?.last_error).toBe('over_quota');
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM leads').first<{ n: number }>()).toEqual({ n: 2 });
  });

  it('does not pay for a lookup once the account is over quota', async () => {
    await env.DB.prepare("UPDATE accounts SET monthly_quota = 1 WHERE id = 'acct_test'").run();
    const first = visitRow(uuidFrom(3));
    await insertVisit(env.DB, first);
    expect((await processVisit(env, first.id, log, stubProvider())).outcome).toBe('resolved'); // uses the one household
    const second = { ...visitRow(uuidFrom(4)), created_at: Date.now() - 20 * 60_000 };
    await insertVisit(env.DB, second);
    const paid = stubProvider(true);
    expect(await processVisit(env, second.id, log, paid)).toMatchObject({ outcome: 'skipped', skipReason: 'over_quota' });
    expect(paid.calls).toBe(0);
    expect((await env.DB.prepare('SELECT skip_reason FROM visits WHERE id = ?').bind(second.id).first<{ skip_reason: string }>())?.skip_reason).toBe('over_quota');
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM identity_requests WHERE provider = 'delivr'").first<{ n: number }>()).toEqual({ n: 0 });
    // The dashboard says so at the limit, not only past it (lookups stop at the limit).
    const page = await (await app.fetch(new Request(`http://localhost/app?key=test-admin-token&site=${SITE_ID}`), env)).text();
    expect(page).toContain("You've reached your plan: 1 of 1 households this month. We stop identifying new visitors until next month.");
  });

  it('never counts fake mock leads against the quota', async () => {
    await env.DB.prepare("UPDATE accounts SET monthly_quota = 1 WHERE id = 'acct_test'").run();
    const [a, b] = await resolvableIds(2);
    const first = visitRow(a!);
    const second = visitRow(b!);
    await insertVisit(env.DB, first);
    await insertVisit(env.DB, second);
    const r1 = await processVisit(env, first.id, log);
    const r2 = await processVisit(env, second.id, log);
    expect([r1.outcome, r2.outcome]).toEqual(['resolved', 'resolved']);
    const statuses = (await env.DB.prepare('SELECT status FROM deliveries').all<{ status: string }>()).results.map((d) => d.status);
    expect(statuses).toEqual(['delivered', 'delivered']);
    expect(await countAccountLeadsSince(env.DB, 'acct_test', 0)).toBe(0);
  });
});
