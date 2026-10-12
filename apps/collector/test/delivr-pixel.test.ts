import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { getSiteByKey, insertSite } from '@yardsign/db';
import { createDelivrPixel, ensureDelivrPixel, retryMissingDelivrPixels } from '../src/delivr-pixel';
import { provision, type CheckoutLike } from '../src/billing';
import { createLogger } from '../src/log';

const log = createLogger({ req_id: 'test' });
const PIXEL = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const keys = { DELIVR_API_KEY: 'dlvr_k', DELIVR_API_SECRET: 's' };

function fakeDelivr(opts: { fail?: boolean } = {}): { fetchFn: typeof fetch; calls: Array<{ url: string; body: unknown }> } {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (opts.fail) return new Response('{"type":"forbidden"}', { status: 403, statusText: 'Forbidden' });
    if (url.endsWith('/api/v1/whoami')) return Response.json({ response: { projects: [{ project_id: 'proj_from_whoami' }] } });
    if (url.endsWith('/api/v1/pixel/create')) return Response.json({ response: { pixel_id: PIXEL, installation_url: `https://cdn.sitelytics.tech/pixels/${PIXEL}/p.js` } }, { status: 201 });
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

async function newSite(key: string) {
  return insertSite(env.DB, { accountId: 'acct_test', siteKey: key, name: 'Roofers Inc', allowedDomains: ['roofers.example'], leadEmail: null });
}

describe('createDelivrPixel', () => {
  it('posts the project id from env and the title, with the key pair', async () => {
    const { fetchFn, calls } = fakeDelivr();
    const made = await createDelivrPixel({ DB: env.DB, ...keys, DELIVR_PROJECT_ID: 'proj_env' }, 'Yardsign: Roofers Inc', fetchFn);
    expect(made.pixelId).toBe(PIXEL);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.delivr.ai/api/v1/pixel/create');
    expect(calls[0]?.body).toEqual({ project_id: 'proj_env', title: 'Yardsign: Roofers Inc' });
  });
  it('asks whoami for the project when env has none', async () => {
    const { fetchFn, calls } = fakeDelivr();
    await createDelivrPixel({ DB: env.DB, ...keys }, 't', fetchFn);
    expect(calls.map((c) => c.url.split('/').pop())).toEqual(['whoami', 'create']);
    expect(calls[1]?.body).toMatchObject({ project_id: 'proj_from_whoami' });
  });
});

describe('ensureDelivrPixel', () => {
  it('creates and stores a pixel for a new site', async () => {
    const site = await newSite('ENSURE1');
    const { fetchFn } = fakeDelivr();
    expect(await ensureDelivrPixel({ DB: env.DB, ...keys, DELIVR_PROJECT_ID: 'p' }, site, log, fetchFn)).toBe(PIXEL);
    expect((await getSiteByKey(env.DB, 'ENSURE1'))?.delivrPixelId).toBe(PIXEL);
  });
  it('does nothing without the key pair, and never calls twice for a site that has one', async () => {
    const site = await newSite('ENSURE2');
    const { fetchFn, calls } = fakeDelivr();
    expect(await ensureDelivrPixel({ DB: env.DB }, site, log, fetchFn)).toBeNull();
    expect(calls).toHaveLength(0);
    expect(await ensureDelivrPixel({ DB: env.DB, ...keys, DELIVR_PROJECT_ID: 'p' }, { ...site, delivrPixelId: 'have-one-already' }, log, fetchFn)).toBe('have-one-already');
    expect(calls).toHaveLength(0);
  });
  it('swallows a Delivr failure: the site is created, stays on mock, nothing throws', async () => {
    const site = await newSite('ENSURE3');
    const { fetchFn } = fakeDelivr({ fail: true });
    expect(await ensureDelivrPixel({ DB: env.DB, ...keys, DELIVR_PROJECT_ID: 'p' }, site, log, fetchFn)).toBeNull();
    expect((await getSiteByKey(env.DB, 'ENSURE3'))?.delivrPixelId).toBeNull();
  });
});

describe('provision gives a Stripe customer a Delivr pixel', () => {
  const session = (): CheckoutLike => ({
    id: 'cs_test_pixel', status: 'complete', mode: 'subscription', payment_status: 'paid', customer: 'cus_1', subscription: 'sub_1',
    customer_details: { email: 'owner@roofers.example' }, metadata: { plan: 'starter', domain: 'roofers.example' },
  });
  it('stores the pixel id on the new site', async () => {
    const { fetchFn } = fakeDelivr();
    const site = await provision({ DB: env.DB, ...keys, DELIVR_PROJECT_ID: 'p' }, session(), Date.now(), log, fetchFn);
    expect(site?.delivrPixelId).toBe(PIXEL);
    expect((await getSiteByKey(env.DB, site?.siteKey ?? ''))?.delivrPixelId).toBe(PIXEL);
  });
  it('still provisions when Delivr is down', async () => {
    const { fetchFn } = fakeDelivr({ fail: true });
    const site = await provision({ DB: env.DB, ...keys, DELIVR_PROJECT_ID: 'p' }, { ...session(), id: 'cs_test_pixel_down' }, Date.now(), log, fetchFn);
    expect(site).not.toBeNull();
    expect(site?.delivrPixelId).toBeNull();
  });
});

describe('the hourly cron retries a missing pixel for a paying site', () => {
  const delivrEnv = { DB: env.DB, ...keys, DELIVR_PROJECT_ID: 'p', IDENTITY_PROVIDER: 'delivr' };
  async function paidSite(key: string, stripeSessionId: string) {
    return insertSite(env.DB, { accountId: 'acct_test', siteKey: key, name: 'Paid Roofers', allowedDomains: ['paid.example'], stripeSessionId });
  }

  it('gives a Stripe site with no pixel one, and leaves other sites alone', async () => {
    await paidSite('RETRY1', 'cs_test_retry1');
    await newSite('RETRY2'); // made by hand, not through Stripe
    const { fetchFn, calls } = fakeDelivr();
    expect(await retryMissingDelivrPixels(delivrEnv, log, fetchFn)).toBe(1);
    expect(calls).toHaveLength(1);
    expect((await getSiteByKey(env.DB, 'RETRY1'))?.delivrPixelId).toBe(PIXEL);
    expect((await getSiteByKey(env.DB, 'RETRY2'))?.delivrPixelId).toBeNull();
    expect((await getSiteByKey(env.DB, 'TESTKEY'))?.delivrPixelId).toBeNull(); // the local test site keeps the mock
    // Done: the next hour has nothing to do.
    expect(await retryMissingDelivrPixels(delivrEnv, log, fetchFn)).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('does nothing unless Delivr is the provider and configured, and survives Delivr being down', async () => {
    await paidSite('RETRY3', 'cs_test_retry3');
    const { fetchFn, calls } = fakeDelivr();
    expect(await retryMissingDelivrPixels({ ...delivrEnv, IDENTITY_PROVIDER: 'mock' }, log, fetchFn)).toBe(0);
    expect(await retryMissingDelivrPixels({ DB: env.DB, IDENTITY_PROVIDER: 'delivr' }, log, fetchFn)).toBe(0);
    expect(calls).toHaveLength(0);
    const down = fakeDelivr({ fail: true });
    expect(await retryMissingDelivrPixels(delivrEnv, log, down.fetchFn)).toBe(0);
    expect((await getSiteByKey(env.DB, 'RETRY3'))?.delivrPixelId).toBeNull();
  });
});
