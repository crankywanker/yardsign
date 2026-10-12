import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { insertVisit, updateSiteDelivery, type DeliveryRow, type NewVisit } from '@yardsign/db';
import { MockProvider } from '@yardsign/identity';
import { CRON_POLL, runScheduled } from '../src/app';
import { EMAIL_NOT_CONFIGURED, MAX_DELIVERY_ATTEMPTS, retryFailedDeliveries } from '../src/delivery';
import { createLogger } from '../src/log';
import { processVisit } from '../src/resolution';
import { SITE_ID, uuidFrom } from './helpers';

const log = createLogger({ req_id: 'test' });
const MIN = 60_000;
const HOOK = 'https://hooks.example.com/yardsign';

function visitRow(visitorId: string): NewVisit {
  return {
    id: crypto.randomUUID(), site_id: SITE_ID, visitor_id: visitorId, session_id: 'sess_abcdefgh', url: 'http://localhost:3000/roof-repair', path: '/roof-repair',
    referrer: null, title: null, ip_hash: 'h', ip_raw: null, country: 'US', region: 'TX', city: 'Plano', postal: '75024', asn: 7018, colo: null,
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

/** Stand in for the network: every webhook and Resend call answers with `status()`. Returns the URLs called. */
function stubNetwork(status: () => number): string[] {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ id: 'msg_1' }), { status: status() });
  });
  return calls;
}

/** A lead whose one delivery failed. Returns that delivery row. */
async function failedDelivery(e: typeof env = env): Promise<DeliveryRow> {
  const v = visitRow(await resolvableVisitorId());
  await insertVisit(env.DB, v);
  const r = await processVisit(e, v.id, log, new MockProvider());
  expect(r.outcome).toBe('resolved');
  const d = await env.DB.prepare('SELECT * FROM deliveries WHERE lead_id = ?').bind(r.leadId).first<DeliveryRow>();
  expect(d).toMatchObject({ status: 'failed', attempts: 1 });
  return d!;
}

const row = (id: string) => env.DB.prepare('SELECT * FROM deliveries WHERE id = ?').bind(id).first<DeliveryRow>();

describe('retrying failed deliveries', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends a failed webhook again once the wait is over, and marks it delivered', async () => {
    await updateSiteDelivery(env.DB, SITE_ID, { leadEmail: null, webhookUrl: HOOK, webhookKind: 'json' });
    let status = 503;
    const calls = stubNetwork(() => status);
    const d = await failedDelivery();
    expect(await retryFailedDeliveries(env, log, d.created_at + 4 * MIN)).toEqual({ retried: 0, delivered: 0 }); // too soon
    status = 200;
    expect(await retryFailedDeliveries(env, log, d.created_at + 6 * MIN)).toEqual({ retried: 1, delivered: 1 });
    expect(await row(d.id)).toMatchObject({ status: 'delivered', attempts: 2, last_error: null });
    expect(calls).toEqual([HOOK, HOOK]);
    // Delivered rows are never sent again.
    expect(await retryFailedDeliveries(env, log, d.created_at + 60 * MIN)).toEqual({ retried: 0, delivered: 0 });
  });

  it('waits 5, 15, 45, then 135 minutes, and stops after five tries', async () => {
    await updateSiteDelivery(env.DB, SITE_ID, { leadEmail: null, webhookUrl: HOOK, webhookKind: 'slack' });
    const calls = stubNetwork(() => 500);
    const d = await failedDelivery();
    const at = (min: number) => retryFailedDeliveries(env, log, d.created_at + min * MIN);
    expect((await at(6)).retried).toBe(1); // try 2
    expect((await at(10)).retried).toBe(0); // next one is due at 5 + 15 = 20
    expect((await at(21)).retried).toBe(1); // try 3
    expect((await at(64)).retried).toBe(0); // due at 65
    expect((await at(66)).retried).toBe(1); // try 4
    expect((await at(201)).retried).toBe(1); // try 5
    expect((await at(23 * 60)).retried).toBe(0); // that was the last
    expect(await row(d.id)).toMatchObject({ status: 'failed', attempts: MAX_DELIVERY_ATTEMPTS, last_error: expect.stringContaining('webhook 500') });
    expect(calls).toHaveLength(MAX_DELIVERY_ATTEMPTS);
  });

  it('gives up after a day', async () => {
    await updateSiteDelivery(env.DB, SITE_ID, { leadEmail: null, webhookUrl: HOOK, webhookKind: 'json' });
    const calls = stubNetwork(() => 500);
    const d = await failedDelivery();
    expect((await retryFailedDeliveries(env, log, d.created_at + 25 * 60 * MIN)).retried).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('does not retry a missing email setup', async () => {
    await updateSiteDelivery(env.DB, SITE_ID, { leadEmail: 'owner@example.com', webhookUrl: null, webhookKind: null });
    const calls = stubNetwork(() => 200);
    const d = await failedDelivery(); // the test env has EMAIL_PROVIDER but no EMAIL_API_KEY
    expect(d.last_error).toBe(EMAIL_NOT_CONFIGURED);
    expect((await retryFailedDeliveries(env, log, d.created_at + 60 * MIN)).retried).toBe(0);
    expect(await row(d.id)).toMatchObject({ status: 'failed', attempts: 1 });
    expect(calls).toHaveLength(0);
  });

  it('never sends to a channel the site no longer has', async () => {
    await updateSiteDelivery(env.DB, SITE_ID, { leadEmail: null, webhookUrl: HOOK, webhookKind: 'json' });
    const calls = stubNetwork(() => 500);
    const d = await failedDelivery();
    await updateSiteDelivery(env.DB, SITE_ID, { leadEmail: null, webhookUrl: null, webhookKind: null });
    expect((await retryFailedDeliveries(env, log, d.created_at + 6 * MIN)).retried).toBe(0);
    expect(await row(d.id)).toMatchObject({ status: 'failed', attempts: MAX_DELIVERY_ATTEMPTS }); // given up, still shows as failed
    expect(calls).toHaveLength(1);
  });

  it('rebuilds the email card the same way and sends it through the sender', async () => {
    await updateSiteDelivery(env.DB, SITE_ID, { leadEmail: 'owner@example.com', webhookUrl: null, webhookKind: null });
    const emailEnv = { ...env, EMAIL_API_KEY: 'k' };
    let status = 500;
    const calls = stubNetwork(() => status);
    const d = await failedDelivery(emailEnv);
    expect(d.channel).toBe('email');
    status = 200;
    expect(await retryFailedDeliveries(emailEnv, log, d.created_at + 6 * MIN)).toEqual({ retried: 1, delivered: 1 });
    expect(calls).toEqual(['https://api.resend.com/emails', 'https://api.resend.com/emails']);
  });

  it('runs from the 5-minute cron', async () => {
    await updateSiteDelivery(env.DB, SITE_ID, { leadEmail: null, webhookUrl: HOOK, webhookKind: 'json' });
    let status = 500;
    stubNetwork(() => status);
    const d = await failedDelivery();
    status = 200;
    await runScheduled(env, CRON_POLL, log, d.created_at + 6 * MIN);
    expect(await row(d.id)).toMatchObject({ status: 'delivered', attempts: 2 });
  });
});
