/**
 * Opt-outs that stick (code review, Oct 8, items 1, 2, 3 and 12): any of the person's emails,
 * phones or home address blocks a match; an opted-out browser is never looked up again; opting
 * out deletes every lead about the person and blanks the raw answers; recalls are queued and
 * retried; customers never get age, income, net worth, marital status or children.
 */
import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteOldVisits, hashEmail, insertVisit, optOut, pendingRecalls, type DeliveryRow, type LeadRow, type NewVisit } from '@yardsign/db';
import type { IdentityProvider, LeadFields, ResolveResult } from '@yardsign/identity';
import { app } from '../src/app';
import { toLeadPayload, type DeliveryChannel } from '../src/delivery';
import { createLogger } from '../src/log';
import { RECALL_RETRY_AFTER_MS, sendOptOutRecalls } from '../src/optout-notice';
import { processVisit } from '../src/resolution';
import { webhookBody } from '../src/webhook';
import { SITE_ID } from './helpers';

const log = createLogger({ req_id: 'test' });

function visit(visitorId = crypto.randomUUID(), over: Partial<NewVisit> = {}): NewVisit {
  const now = Date.now();
  return {
    id: crypto.randomUUID(), site_id: SITE_ID, visitor_id: visitorId, session_id: 'sess_abcdefgh', url: 'http://localhost:3000/', path: '/',
    referrer: null, title: null, ip_hash: 'h', ip_raw: null, country: 'US', region: 'TX', city: 'Plano', postal: '75024', asn: 7018, colo: null,
    lat: null, lng: null, user_agent: 'Mozilla/5.0', device: '{}', screen: '{}', timezone: null, language: null, bot_score: null,
    occurred_at: now, created_at: now, gpc: 0, asn_org: 'AT&T', asn_class: 'residential', ...over,
  };
}

const PAT: LeadFields = { first_name: 'Pat', last_name: 'Example', address_line1: '12 Oak St', city: 'Plano', state: 'TX', zip: '75024', phone: '(972) 555-0101', email: 'pat@example.com' };

/** A provider that answers with `lead`, and the extra emails and phones the row carried. Counts its calls. */
function provider(lead: LeadFields, more: Pick<ResolveResult, 'emails' | 'phones'> = {}): IdentityProvider & { calls: number } {
  const p = { name: 'fake', calls: 0, resolve: async (): Promise<ResolveResult> => (p.calls++, { status: 'resolved', lead, raw: { row: { ...lead, ...more } }, ...more }) };
  return p;
}

function channel(): DeliveryChannel & { sent: LeadRow[] } {
  const sent: LeadRow[] = [];
  return { name: 'test', sent, send: async (l: LeadRow) => void sent.push(l) };
}

async function resolveVisit(v: NewVisit, p: IdentityProvider, ch = channel()) {
  await insertVisit(env.DB, v);
  return processVisit(env, v.id, log, p, ch);
}

const count = async (sql: string): Promise<number> => (await env.DB.prepare(sql).first<{ n: number }>())?.n ?? 0;

describe('opting out with any of the person\'s emails', () => {
  it('deletes the lead even when the lead shows a different email', async () => {
    const r = await resolveVisit(visit(), provider(PAT, { emails: ['pat@example.com', 'pat.work@globex.example'] }));
    expect(r.outcome).toBe('resolved');
    const { deleted } = await optOut(env.DB, await hashEmail('Pat.Work@Globex.example'));
    expect(deleted).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM leads')).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM lead_keys')).toBe(0);
  });

  it('also deletes another lead for the same browser that has no email (an email-only match and its later card)', async () => {
    const vid = crypto.randomUUID();
    await resolveVisit(visit(vid), provider({ email: 'pat@example.com', state: 'TX' })); // email only: the re-check stays open
    await resolveVisit(visit(vid), provider({ ...PAT, email: undefined, phone: undefined })); // the full card, with no email on it
    expect(await count('SELECT COUNT(*) AS n FROM leads')).toBe(2);
    const { deleted, recallIds } = await optOut(env.DB, await hashEmail('pat@example.com'));
    expect(deleted).toBe(2);
    expect(recallIds).toHaveLength(2);
    expect(await count('SELECT COUNT(*) AS n FROM leads')).toBe(0);
  });

  it('blanks the raw answers, drops the deliveries and the house\'s score row', async () => {
    const v = visit();
    await resolveVisit(v, provider(PAT, { emails: ['pat@example.com', 'p2@example.com'] }));
    await env.DB.prepare("INSERT INTO lead_scores (id, visit_id, lead_id, score, components, scored_at) SELECT 'score_x', ?, id, 10, '{\"location\":{\"lat\":33,\"lng\":-96}}', 1 FROM leads").bind(v.id).run();
    await optOut(env.DB, await hashEmail('pat@example.com'));
    const raw = await env.DB.prepare('SELECT response_payload FROM identity_requests').first<{ response_payload: string }>();
    expect(JSON.parse(raw!.response_payload)).toEqual({ rows: null, opted_out: 1 });
    expect(await count('SELECT COUNT(*) AS n FROM deliveries')).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM lead_scores WHERE id = 'score_x'")).toBe(0);
  });
});

describe('a later match for someone who opted out', () => {
  it('is thrown away when any email in the row is opted out, not just the one on the lead', async () => {
    await optOut(env.DB, await hashEmail('pat.work@globex.example'));
    const ch = channel();
    const r = await resolveVisit(visit(), provider(PAT, { emails: ['pat@example.com', 'pat.work@globex.example'] }), ch);
    expect(r.outcome).toBe('opted_out');
    expect(ch.sent).toHaveLength(0);
  });

  it('is thrown away by phone when the match has no email', async () => {
    await resolveVisit(visit(), provider(PAT)); // the lead that gets deleted carries the phone
    await optOut(env.DB, await hashEmail('pat@example.com'));
    const ch = channel();
    const r = await resolveVisit(visit(), provider({ ...PAT, email: undefined, address_line1: undefined, phone: '+1 972-555-0101' }), ch);
    expect(r.outcome).toBe('opted_out');
    expect(ch.sent).toHaveLength(0);
  });

  it('is thrown away by name and home address when it has no email or phone', async () => {
    await resolveVisit(visit(), provider(PAT));
    await optOut(env.DB, await hashEmail('pat@example.com'));
    const r = await resolveVisit(visit(), provider({ ...PAT, email: undefined, phone: undefined, address_line1: '12 OAK ST.' }));
    expect(r.outcome).toBe('opted_out');
  });

  it('is never looked up again from the same browser, so we never pay to find them', async () => {
    const vid = crypto.randomUUID();
    await resolveVisit(visit(vid), provider(PAT));
    await optOut(env.DB, await hashEmail('pat@example.com'));
    const p = provider(PAT);
    const r = await resolveVisit(visit(vid), p);
    expect(r).toMatchObject({ outcome: 'skipped', skipReason: 'opted_out' });
    expect(p.calls).toBe(0);
  });

  it('remembers the browser when a match turns out to be opted out', async () => {
    await optOut(env.DB, await hashEmail('pat@example.com'));
    const vid = crypto.randomUUID();
    expect((await resolveVisit(visit(vid), provider(PAT))).outcome).toBe('opted_out');
    const p = provider(PAT);
    expect((await resolveVisit(visit(vid), p)).outcome).toBe('skipped');
    expect(p.calls).toBe(0);
  });

  it('someone else is still found', async () => {
    await optOut(env.DB, await hashEmail('pat@example.com'));
    const r = await resolveVisit(visit(), provider({ ...PAT, first_name: 'Sam', last_name: 'Other', address_line1: '9 Elm St', phone: '(972) 555-0199', email: 'sam@example.com' }));
    expect(r.outcome).toBe('resolved');
  });
});

describe('recall notices', () => {
  afterEach(() => vi.restoreAllMocks());
  const mailEnv = { ...env, EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 'k', EMAIL_FROM: 'leads@example.com' };

  it('queues one per lead, sends them grouped by business, and keeps nothing once sent', async () => {
    await env.DB.prepare("UPDATE sites SET lead_email = 'roofer@example.com' WHERE id = ?").bind(SITE_ID).run();
    await resolveVisit(visit(), provider(PAT));
    const { recallIds } = await optOut(env.DB, await hashEmail('pat@example.com'));
    const sent: Array<{ to: string[]; text: string }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { to: string[]; text: string };
      sent.push(body);
      return new Response(JSON.stringify({ id: 'x' }), { status: 200 });
    });
    expect(await sendOptOutRecalls(mailEnv, 'Yardsign', log, { ids: recallIds })).toBe(1);
    expect(sent[0]?.to).toEqual(['roofer@example.com']);
    expect(sent[0]?.text).toContain('Pat Example');
    expect(await count('SELECT COUNT(*) AS n FROM optout_recalls')).toBe(0);
  });

  it('a failed send stays queued and the cron sends it later, with back-off', async () => {
    await resolveVisit(visit(), provider(PAT));
    const now = Date.now();
    const { recallIds } = await optOut(env.DB, await hashEmail('pat@example.com'), now);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('down', { status: 503, statusText: 'Unavailable' }));
    expect(await sendOptOutRecalls(mailEnv, 'Yardsign', log, { ids: recallIds, now })).toBe(0);
    const [row] = await pendingRecalls(env.DB, { ids: recallIds });
    expect(row?.attempts).toBe(1);

    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 'x' }), { status: 200 }));
    // Too soon: the first retry waits five minutes after the failed try, and a fresh opt-out ten.
    expect(await sendOptOutRecalls(mailEnv, 'Yardsign', log, { now: now + 60_000 })).toBe(0);
    expect(await sendOptOutRecalls(mailEnv, 'Yardsign', log, { now: now + RECALL_RETRY_AFTER_MS + 60_000 })).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM optout_recalls')).toBe(0);
  });

  it('waits for email to be set up instead of dropping the recall', async () => {
    await resolveVisit(visit(), provider(PAT));
    const { recallIds } = await optOut(env.DB, await hashEmail('pat@example.com'));
    expect(await sendOptOutRecalls({ ...env, EMAIL_PROVIDER: '' }, 'Yardsign', log, { ids: recallIds })).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM optout_recalls')).toBe(1);
  });

  it('the opt-out page queues and sends the recall', async () => {
    await env.DB.prepare("UPDATE sites SET lead_email = 'roofer@example.com' WHERE id = ?").bind(SITE_ID).run();
    await resolveVisit(visit(), provider(PAT));
    const res = await app.fetch(
      new Request('http://localhost/optout', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'pat@example.com' }) }),
      { ...env, EMAIL_PROVIDER: '' },
    );
    expect(res.status).toBe(200);
    expect(await count('SELECT COUNT(*) AS n FROM leads')).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM optout_recalls')).toBe(1); // email is off in this test, so it waits in the queue
  });
});

describe('what customers get', () => {
  const lead = (extra: Record<string, unknown>): LeadRow =>
    ({
      id: 'l1', site_id: SITE_ID, visitor_id: 'v', identity_request_id: 'r', first_name: 'Pat', last_name: 'Example', address_line1: '12 Oak St', address_line2: null,
      city: 'Plano', state: 'TX', zip: '75024', phone: null, email: 'pat@example.com', confidence: 0.8, lat: null, lng: null, linkedin_url: null,
      email_hash: null, extra: JSON.stringify(extra), created_at: 0,
    }) as LeadRow;
  const OLD = { provider: 'delivr', is_homeowner: true, is_married: true, has_children: false, age_range: '35-44', income_range: '100k', net_worth: '250k', cookie_id: 'c', event_id: 'e', pixel_id: 'p' };

  it('the feed and JSON webhooks carry no age, income, net worth, marital status, children or provider ids', () => {
    const payload = toLeadPayload(lead(OLD));
    expect(payload.extra).toEqual({ provider: 'delivr', is_homeowner: true });
    const body = JSON.stringify(webhookBody('json', payload, { siteName: 'S', pages: [], mock: false }));
    for (const f of ['is_married', 'has_children', 'age_range', 'income_range', 'net_worth', 'cookie_id', 'event_id', 'pixel_id']) expect(body).not.toContain(f);
  });

  it('bad JSON in extra is just empty', () => {
    expect(toLeadPayload({ ...lead({}), extra: 'not json' }).extra).toEqual({});
  });
});

describe('retention', () => {
  it('deletes 13-month-old visits that were looked up but never led to a lead, and keeps ones that did', async () => {
    const old = Date.now() - 400 * 24 * 3600 * 1000;
    const missed = visit(crypto.randomUUID(), { created_at: old, occurred_at: old });
    const matched = visit(crypto.randomUUID(), { created_at: old, occurred_at: old });
    await insertVisit(env.DB, missed);
    await processVisit(env, missed.id, log, { name: 'fake', resolve: async () => ({ status: 'no_match' }) }, channel());
    await resolveVisit(matched, provider(PAT));
    expect(await count('SELECT COUNT(*) AS n FROM identity_requests')).toBe(2);
    expect(await deleteOldVisits(env.DB)).toBe(1);
    const left = (await env.DB.prepare('SELECT id FROM visits').all<{ id: string }>()).results.map((r) => r.id);
    expect(left).toEqual([matched.id]);
    expect(await count('SELECT COUNT(*) AS n FROM identity_requests')).toBe(1);
    expect((await env.DB.prepare('SELECT * FROM deliveries').all<DeliveryRow>()).results.length).toBeGreaterThan(0);
  });
});
