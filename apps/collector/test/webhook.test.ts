import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { insertVisit, type DeliveryRow, type NewVisit } from '@yardsign/db';
import { MockProvider } from '@yardsign/identity';
import { toLeadPayload } from '../src/delivery';
import { createLogger } from '../src/log';
import { processVisit } from '../src/resolution';
import { WebhookChannel, isAllowedWebhookUrl, webhookBody } from '../src/webhook';
import { SITE_ID, uuidFrom } from './helpers';

const log = createLogger({ req_id: 'test' });

const SAMPLE = toLeadPayload({
  id: 'lead_1', site_id: SITE_ID, visitor_id: uuidFrom(1), identity_request_id: 'req_1',
  first_name: 'Maria', last_name: 'Garcia', address_line1: '412 Example Ln', address_line2: null,
  city: 'Plano', state: 'TX', zip: '75024', phone: '(972) 555-0142', email: 'maria.garcia@example.com',
  confidence: 0.84, lat: null, lng: null, linkedin_url: null, email_hash: null, extra: '{}', created_at: 0,
});
const CTX = { siteName: 'Test Roofing', pages: ['/roof-repair'], mock: true };

describe('webhook bodies', () => {
  it('json carries the full payload plus pages and the test flag', () => {
    const b = webhookBody('json', SAMPLE, CTX) as Record<string, unknown>;
    expect(b.first_name).toBe('Maria');
    expect(b.test).toBe(true);
    expect(b.pages).toEqual(['/roof-repair']);
    expect(b.source).toBe('Yardsign');
  });
  it('slack is a single text message with the test marker', () => {
    const b = webhookBody('slack', SAMPLE, CTX) as { text: string };
    expect(b.text).toContain('TEST LEAD');
    expect(b.text).toContain('Maria Garcia');
    expect(b.text).toContain('(972) 555-0142');
  });
  it('ghl maps to contact fields and tags', () => {
    const b = webhookBody('ghl', SAMPLE, { ...CTX, mock: false }) as { firstName: string; postalCode: string; tags: string[] };
    expect(b.firstName).toBe('Maria');
    expect(b.postalCode).toBe('75024');
    expect(b.tags).toContain('yardsign');
    expect(b.tags).not.toContain('yardsign-test');
  });
});

describe('isAllowedWebhookUrl', () => {
  it('allows https to outside hosts only', () => {
    expect(isAllowedWebhookUrl('https://hooks.slack.com/services/T/B/x', 'tryyardsign.com')).toBe(true);
    expect(isAllowedWebhookUrl('http://hooks.slack.com/x')).toBe(false);
    expect(isAllowedWebhookUrl('https://tryyardsign.com/collect', 'tryyardsign.com')).toBe(false);
    expect(isAllowedWebhookUrl('https://localhost/x')).toBe(false);
    expect(isAllowedWebhookUrl('https://10.0.0.5/x')).toBe(false);
    expect(isAllowedWebhookUrl('https://192.168.1.1/x')).toBe(false);
    expect(isAllowedWebhookUrl('not a url')).toBe(false);
  });

  it('allows ordinary names that start with fc or fd, or with digits', () => {
    expect(isAllowedWebhookUrl('https://fcm.example.com/hook')).toBe(true);
    expect(isAllowedWebhookUrl('https://fdhooks.io/x')).toBe(true);
    expect(isAllowedWebhookUrl('https://fe80hooks.example.com/x')).toBe(true);
    expect(isAllowedWebhookUrl('https://10.example.com/x')).toBe(true);
    expect(isAllowedWebhookUrl('https://203.0.113.5/x')).toBe(true); // a public address
    expect(isAllowedWebhookUrl('https://[2001:db8::1]/x')).toBe(true);
  });

  it('blocks our own domain at any depth, Workers, and localhost with a trailing dot', () => {
    expect(isAllowedWebhookUrl('https://tryyardsign.com/collect')).toBe(false); // even when the request came in on another host
    expect(isAllowedWebhookUrl('https://www.tryyardsign.com/x')).toBe(false);
    expect(isAllowedWebhookUrl('https://a.b.TryYardsign.com./x')).toBe(false);
    expect(isAllowedWebhookUrl('https://nottryyardsign.com/x')).toBe(true);
    expect(isAllowedWebhookUrl('https://yardsign-collector.someone.workers.dev/collect')).toBe(false);
    expect(isAllowedWebhookUrl('https://localhost./x')).toBe(false);
    expect(isAllowedWebhookUrl('https://api.localhost/x')).toBe(false);
    expect(isAllowedWebhookUrl('https://hooks.example.com./x')).toBe(true);
  });

  it('blocks private IPv6 literals, IPv4 inside IPv6, and carrier-grade NAT', () => {
    expect(isAllowedWebhookUrl('https://[::1]/x')).toBe(false);
    expect(isAllowedWebhookUrl('https://[::]/x')).toBe(false);
    expect(isAllowedWebhookUrl('https://[fc00::1]/x')).toBe(false);
    expect(isAllowedWebhookUrl('https://[fd12:3456::1]/x')).toBe(false);
    expect(isAllowedWebhookUrl('https://[FE80::1]/x')).toBe(false);
    expect(isAllowedWebhookUrl('https://[febf::1]/x')).toBe(false);
    expect(isAllowedWebhookUrl('https://[::ffff:127.0.0.1]/x')).toBe(false);
    expect(isAllowedWebhookUrl('https://[::ffff:10.1.2.3]/x')).toBe(false);
    expect(isAllowedWebhookUrl('https://[::ffff:192.168.0.1]/x')).toBe(false);
    expect(isAllowedWebhookUrl('https://[::ffff:8.8.8.8]/x')).toBe(true);
    expect(isAllowedWebhookUrl('https://100.64.0.1/x')).toBe(false);
    expect(isAllowedWebhookUrl('https://100.127.255.254/x')).toBe(false);
    expect(isAllowedWebhookUrl('https://100.128.0.1/x')).toBe(true);
    expect(isAllowedWebhookUrl('https://100.63.0.1/x')).toBe(true);
    expect(isAllowedWebhookUrl('https://172.16.0.1/x')).toBe(false);
    expect(isAllowedWebhookUrl('https://169.254.169.254/x')).toBe(false);
    expect(isAllowedWebhookUrl('https://0x7f.1/x')).toBe(false); // the URL parser turns this into 127.0.0.1
  });
});

describe('webhook channel in the resolution step', () => {
  async function resolvable(): Promise<string> {
    const p = new MockProvider();
    for (let i = 0; i < 500; i++) {
      const vid = uuidFrom(i);
      const r = await p.resolve({ visitor_id: vid, visit_id: 'x', site_id: SITE_ID, ip: null, ip_hash: 'h', user_agent: null, geo: { country: null, region: null, city: null, postal: null, lat: null, lng: null, asn: null }, occurred_at: 0, created_at: 0 });
      if (r.status === 'resolved') return vid;
    }
    throw new Error('mock never resolved');
  }
  function visitRow(visitorId: string): NewVisit {
    return {
      id: crypto.randomUUID(), site_id: SITE_ID, visitor_id: visitorId, session_id: 'sess_abcdefgh', url: 'http://localhost:3000/', path: '/',
      referrer: null, title: null, ip_hash: 'h', ip_raw: null, country: 'US', region: 'TX', city: 'Plano', postal: '75024', asn: null, colo: null,
      lat: null, lng: null, user_agent: 'Mozilla/5.0', device: '{}', screen: '{}', timezone: null, language: null, bot_score: null,
      occurred_at: Date.now(), created_at: Date.now(), gpc: 0, asn_org: 'AT&T', asn_class: 'residential',
    };
  }

  it('posts the lead and records the delivery, including failures', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const okFetch: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), body: String(init?.body) });
      return new Response('ok', { status: 200 });
    };
    const v = visitRow(await resolvable());
    await insertVisit(env.DB, v);
    const ch = new WebhookChannel('https://hooks.example.com/abc', 'json', async () => CTX, okFetch);
    const r = await processVisit(env, v.id, log, new MockProvider(), ch);
    expect(r.outcome).toBe('resolved');
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.body).lead_id).toBe(r.leadId);
    const d = await env.DB.prepare('SELECT * FROM deliveries WHERE lead_id = ?').bind(r.leadId).first<DeliveryRow>();
    expect(d?.channel).toBe('webhook:json');
    expect(d?.status).toBe('delivered');

    const v2 = visitRow(uuidFrom(9999));
    // force a second resolvable visitor by using a different site-scoped visitor: reuse the first id on a fresh visit is deduped, so insert directly a lead-less visit for a new resolvable id
    const badFetch: typeof fetch = async () => new Response('nope', { status: 500 });
    const p = new MockProvider();
    let vid2 = '';
    for (let i = 1000; i < 2000; i++) {
      const cand = uuidFrom(i);
      const res = await p.resolve({ visitor_id: cand, visit_id: 'x', site_id: SITE_ID, ip: null, ip_hash: 'h', user_agent: null, geo: { country: null, region: null, city: null, postal: null, lat: null, lng: null, asn: null }, occurred_at: 0, created_at: 0 });
      if (res.status === 'resolved') { vid2 = cand; break; }
    }
    const v3 = { ...v2, visitor_id: vid2 };
    await insertVisit(env.DB, v3);
    const r2 = await processVisit(env, v3.id, log, p, new WebhookChannel('https://hooks.example.com/abc', 'slack', async () => CTX, badFetch));
    expect(r2.outcome).toBe('resolved');
    const d2 = await env.DB.prepare('SELECT * FROM deliveries WHERE lead_id = ?').bind(r2.leadId).first<DeliveryRow>();
    expect(d2?.status).toBe('failed');
    expect(d2?.last_error).toContain('500');
  });
});
