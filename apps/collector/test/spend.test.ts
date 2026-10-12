import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { DAY_MS, completeIdentityRequest, hadIdentityRequestRecently, insertIdentityRequest, insertVisit, sessionEngagement, setTimeOnPage, sumIdentityCostSince, type NewVisit } from '@yardsign/db';
import type { IdentityProvider, ResolveResult } from '@yardsign/identity';
import type { EmailMessage, EmailSender } from '../src/email/sender';
import { createLogger } from '../src/log';
import { processVisit } from '../src/resolution';
import {
  ALERT_PERCENTS,
  DEFAULT_DAILY_CAP_CENTS,
  DEFAULT_MONTHLY_CAP_CENTS,
  ENGAGEMENT_WAIT_MS,
  SpendAlerter,
  checkSpendCaps,
  engagementVerdict,
  spendCaps,
} from '../src/spend';
import { SITE_ID, uuidFrom } from './helpers';

const log = createLogger({ req_id: 'test' });
/** Tuesday Oct 7, 2026, 15:00 UTC. */
const NOW = Date.UTC(2026, 9, 7, 15, 0, 0);
const CAPS = { monthlyCapCents: 125_000, dailyCapCents: 1_000 };
const dayStart = Date.UTC(2026, 9, 7);

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

function visitRow(visitorId: string, createdAt: number, over: Partial<NewVisit> = {}): NewVisit {
  return {
    id: crypto.randomUUID(), site_id: SITE_ID, visitor_id: visitorId, session_id: 'sess_' + visitorId.slice(0, 8), url: 'http://localhost:3000/', path: '/',
    referrer: null, title: null, ip_hash: 'h', ip_raw: '203.0.113.10', country: 'US', region: 'TX', city: 'Plano', postal: '75024', asn: 7018, colo: 'DFW',
    lat: 33.0198, lng: -96.6989, user_agent: 'Mozilla/5.0', device: '{}', screen: '{}', timezone: 'America/Chicago', language: 'en-US', bot_score: null,
    occurred_at: createdAt, created_at: createdAt, gpc: 0, asn_org: 'AT&T', asn_class: 'residential', ...over,
  };
}

/** A paid provider that looks like Delivr to the spend guard and counts its calls. */
function paidProvider(result: ResolveResult = { status: 'no_match', cost_cents: 2.5 }): IdentityProvider & { calls: number } {
  const p = {
    name: 'delivr',
    maxCostCentsPerCall: 2.5,
    calls: 0,
    async resolve(): Promise<ResolveResult> {
      p.calls++;
      return result;
    },
  };
  return p;
}

/** Seed one completed Delivr request with a cost, attached to its own old visit. */
async function seedSpend(cents: number, at: number, visitorId = uuidFrom(7000)): Promise<void> {
  const v = visitRow(visitorId, at - 1000);
  await insertVisit(env.DB, v);
  const id = await insertIdentityRequest(env.DB, { visitId: v.id, provider: 'delivr', requestPayload: {} }, at);
  await completeIdentityRequest(env.DB, id, { status: 'no_match', responsePayload: null, costCents: cents }, at);
  await env.DB.prepare('UPDATE visits SET resolve_attempted_at = ? WHERE id = ?').bind(at, v.id).run();
}

/** An engaged session: two page views for the same visitor and session. */
async function engagedVisit(visitorId: string, createdAt: number): Promise<NewVisit> {
  const first = visitRow(visitorId, createdAt - 20_000);
  const second = visitRow(visitorId, createdAt, { session_id: first.session_id });
  await insertVisit(env.DB, first);
  await insertVisit(env.DB, second);
  await env.DB.prepare('UPDATE visits SET resolve_attempted_at = ?, skip_reason = ? WHERE id = ?').bind(createdAt, 'test_seed', first.id).run();
  return second;
}

const old = NOW - 20 * 60_000; // 20 minutes: past Delivr's 10-minute minimum, inside the 30-minute engagement wait

describe('spend caps', () => {
  it('reads the caps from env and falls back to the defaults on junk', () => {
    expect(spendCaps({ DELIVR_MONTHLY_CAP_CENTS: '125000', DELIVR_DAILY_CAP_CENTS: '1000' })).toEqual(CAPS);
    expect(spendCaps({})).toEqual({ monthlyCapCents: DEFAULT_MONTHLY_CAP_CENTS, dailyCapCents: DEFAULT_DAILY_CAP_CENTS });
    expect(spendCaps({ DELIVR_MONTHLY_CAP_CENTS: 'lots', DELIVR_DAILY_CAP_CENTS: '-5' })).toEqual({ monthlyCapCents: DEFAULT_MONTHLY_CAP_CENTS, dailyCapCents: DEFAULT_DAILY_CAP_CENTS });
    expect(spendCaps({ DELIVR_MONTHLY_CAP_CENTS: ' ', DELIVR_DAILY_CAP_CENTS: '' })).toEqual({ monthlyCapCents: DEFAULT_MONTHLY_CAP_CENTS, dailyCapCents: DEFAULT_DAILY_CAP_CENTS });
  });

  it('reads a cap of "0" as zero: no paid calls at all', async () => {
    expect(spendCaps({ DELIVR_MONTHLY_CAP_CENTS: '0', DELIVR_DAILY_CAP_CENTS: '0' })).toEqual({ monthlyCapCents: 0, dailyCapCents: 0 });
    const v = await engagedVisit(uuidFrom(30), old);
    const p = paidProvider();
    expect(await processVisit({ ...env, DELIVR_DAILY_CAP_CENTS: '0' }, v.id, log, p, undefined, () => NOW)).toMatchObject({ outcome: 'skipped', skipReason: 'daily_spend_cap' });
    expect(p.calls).toBe(0);
  });

  it('counts a pending call (in flight, or cut off mid-call) at the worst case', async () => {
    await seedSpend(10, NOW - 60_000, uuidFrom(31));
    const v = visitRow(uuidFrom(32), NOW - 120_000);
    await insertVisit(env.DB, v);
    await insertIdentityRequest(env.DB, { visitId: v.id, provider: 'delivr', requestPayload: {} }, NOW - 60_000); // never completed
    expect(await sumIdentityCostSince(env.DB, 'delivr', dayStart)).toBe(10);
    expect(await sumIdentityCostSince(env.DB, 'delivr', dayStart, 3)).toBe(13);
    const r = await checkSpendCaps(env.DB, 'delivr', 2.5, { monthlyCapCents: 1_000_000, dailyCapCents: 15 }, NOW);
    expect(r).toMatchObject({ ok: false, reason: 'daily_spend_cap', dayCents: 13 });
  });

  it('sums only the named provider since the start of the month and of the day', async () => {
    await seedSpend(300, NOW - 2 * 60_000, uuidFrom(1));
    await seedSpend(400, NOW - 3 * DAY_MS, uuidFrom(2)); // earlier this month
    await seedSpend(500, Date.UTC(2026, 8, 30), uuidFrom(3)); // last month
    const mock = visitRow(uuidFrom(4), NOW - 1000);
    await insertVisit(env.DB, mock);
    const id = await insertIdentityRequest(env.DB, { visitId: mock.id, provider: 'mock', requestPayload: {} }, NOW);
    await completeIdentityRequest(env.DB, id, { status: 'no_match', responsePayload: null, costCents: 9999 });
    expect(await sumIdentityCostSince(env.DB, 'delivr', Date.UTC(2026, 9, 1))).toBe(700);
    expect(await sumIdentityCostSince(env.DB, 'delivr', Date.UTC(2026, 9, 7))).toBe(300);
  });

  it('allows a call under both caps and blocks one that would cross the month', async () => {
    await seedSpend(124_997, NOW - 60_000);
    expect((await checkSpendCaps(env.DB, 'delivr', 2.5, { monthlyCapCents: 125_000, dailyCapCents: 1_000_000 }, NOW)).ok).toBe(true);
    const blocked = await checkSpendCaps(env.DB, 'delivr', 2.5, { monthlyCapCents: 124_999, dailyCapCents: 1_000_000 }, NOW);
    expect(blocked).toMatchObject({ ok: false, reason: 'spend_cap', monthCents: 124_997 });
  });

  it('blocks on the daily cap when the month still has room', async () => {
    await seedSpend(998, NOW - 60_000);
    const r = await checkSpendCaps(env.DB, 'delivr', 2.5, CAPS, NOW);
    expect(r).toMatchObject({ ok: false, reason: 'daily_spend_cap', dayCents: 998 });
  });

  it('fails closed when the spend query throws', async () => {
    const broken = { prepare: () => { throw new Error('d1 down'); } } as unknown as D1Database;
    const r = await checkSpendCaps(broken, 'delivr', 2.5, CAPS, NOW);
    expect(r).toMatchObject({ ok: false, reason: 'spend_check_error' });
  });
});

describe('engagement gate', () => {
  it('counts page views and the longest stay in a session', async () => {
    const a = visitRow(uuidFrom(10), NOW - 30_000);
    await insertVisit(env.DB, a);
    expect(await sessionEngagement(env.DB, SITE_ID, a.session_id)).toEqual({ views: 1, maxTimeOnPageMs: 0 });
    await setTimeOnPage(env.DB, SITE_ID, a.visitor_id, a.id, 12_000);
    expect(await sessionEngagement(env.DB, SITE_ID, a.session_id)).toEqual({ views: 1, maxTimeOnPageMs: 12_000 });
  });

  it('waits on a lone fresh view, skips a lone stale one, passes two views or ten seconds', async () => {
    const lone = visitRow(uuidFrom(11), NOW - 60_000);
    await insertVisit(env.DB, lone);
    expect(await engagementVerdict(env.DB, lone, NOW)).toBe('wait');
    expect(await engagementVerdict(env.DB, lone, NOW + ENGAGEMENT_WAIT_MS)).toBe('skip');
    await setTimeOnPage(env.DB, SITE_ID, lone.visitor_id, lone.id, 10_000);
    expect(await engagementVerdict(env.DB, lone, NOW + ENGAGEMENT_WAIT_MS)).toBe('engaged');

    const two = await engagedVisit(uuidFrom(12), NOW - 60_000);
    expect(await engagementVerdict(env.DB, two, NOW)).toBe('engaged');
  });
});

describe('processVisit with a paid provider', () => {
  it('calls the provider for an engaged visit under the caps and records the cost', async () => {
    const v = await engagedVisit(uuidFrom(20), old);
    const p = paidProvider();
    const r = await processVisit(env, v.id, log, p, undefined, () => NOW);
    expect(r.outcome).toBe('no_match');
    expect(p.calls).toBe(1);
    expect(await sumIdentityCostSince(env.DB, 'delivr', 0)).toBe(3); // 2.5 rounds up to a whole cent
  });

  it('asks about a lone page view when the engagement gate is off (the default)', async () => {
    const v = visitRow(uuidFrom(24), old);
    await insertVisit(env.DB, v);
    const p = paidProvider();
    expect((await processVisit({ ...env, DELIVR_ENGAGEMENT_GATE: undefined }, v.id, log, p, undefined, () => NOW)).outcome).toBe('no_match');
    expect(p.calls).toBe(1);
  });

  it('with the gate on, defers a lone fresh view, then skips it as no_engagement once it is stale', async () => {
    const v = visitRow(uuidFrom(21), old);
    await insertVisit(env.DB, v);
    const p = paidProvider();
    const gated = { ...env, DELIVR_ENGAGEMENT_GATE: 'on' };
    expect((await processVisit(gated, v.id, log, p, undefined, () => NOW)).outcome).toBe('deferred');
    expect((await env.DB.prepare('SELECT resolve_attempted_at FROM visits WHERE id = ?').bind(v.id).first<{ resolve_attempted_at: number | null }>())?.resolve_attempted_at).toBeNull();
    const later = await processVisit(gated, v.id, log, p, undefined, () => NOW + ENGAGEMENT_WAIT_MS);
    expect(later).toMatchObject({ outcome: 'skipped', skipReason: 'no_engagement' });
    expect(p.calls).toBe(0);
    expect((await env.DB.prepare('SELECT skip_reason FROM visits WHERE id = ?').bind(v.id).first<{ skip_reason: string }>())?.skip_reason).toBe('no_engagement');
  });

  it('never calls when the monthly cap would be crossed, marks the visit, and emails the cap-hit alert once', async () => {
    await seedSpend(124_999, NOW - 60_000);
    const p = paidProvider();
    const a = await engagedVisit(uuidFrom(22), old);
    const r = await processVisit(env, a.id, log, p, undefined, () => NOW);
    expect(r).toMatchObject({ outcome: 'skipped', skipReason: 'spend_cap' });
    expect(p.calls).toBe(0);
    expect((await env.DB.prepare('SELECT skip_reason FROM visits WHERE id = ?').bind(a.id).first<{ skip_reason: string }>())?.skip_reason).toBe('spend_cap');
    // The 100% alert was claimed once (the test env has no email provider, so it went to the log).
    const b = await engagedVisit(uuidFrom(23), old);
    expect((await processVisit(env, b.id, log, p, undefined, () => NOW)).skipReason).toBe('spend_cap');
    const keys = (await env.DB.prepare('SELECT key FROM spend_alerts ORDER BY key').all<{ key: string }>()).results.map((r) => r.key);
    expect(keys).toEqual(['delivr:month:2026-10:100']);
  });

  it('never calls when the daily cap would be crossed and claims the daily alert once per day', async () => {
    await seedSpend(999, NOW - 60_000); // $10 a day
    const p = paidProvider();
    const a = await engagedVisit(uuidFrom(24), old);
    expect(await processVisit(env, a.id, log, p, undefined, () => NOW)).toMatchObject({ outcome: 'skipped', skipReason: 'daily_spend_cap' });
    const b = await engagedVisit(uuidFrom(25), old);
    expect((await processVisit(env, b.id, log, p, undefined, () => NOW)).skipReason).toBe('daily_spend_cap');
    expect(p.calls).toBe(0);
    const keys = (await env.DB.prepare('SELECT key FROM spend_alerts').all<{ key: string }>()).results.map((r) => r.key);
    expect(keys).toEqual(['delivr:day:2026-10-07:cap']);
  });

  it('asks again on a return visit after a free miss (Delivr matches returning browsers)', async () => {
    const t = Date.now();
    const vid = uuidFrom(28);
    const first = await engagedVisit(vid, t - 80 * 60_000);
    const miss = paidProvider({ status: 'no_match' });
    expect((await processVisit(env, first.id, log, miss, undefined, () => t)).outcome).toBe('no_match');
    expect(await hadIdentityRequestRecently(env.DB, SITE_ID, vid, DAY_MS, t, 'delivr')).toBe(false);
    const second = visitRow(vid, t - 20 * 60_000, { session_id: first.session_id });
    await insertVisit(env.DB, second);
    expect((await processVisit(env, second.id, log, miss, undefined, () => t)).outcome).toBe('no_match');
    expect(miss.calls).toBe(2);
  });

  it('asks about a visitor at most once per 24 hours after a billed call', async () => {
    // Real clock here: the identity request the step writes is stamped with Date.now(), not the test's NOW.
    const t = Date.now();
    const recent = t - 20 * 60_000;
    const vid = uuidFrom(26);
    const first = await engagedVisit(vid, recent - 60 * 60_000);
    const p = paidProvider({ status: 'no_match', cost_cents: 2.5 });
    expect((await processVisit(env, first.id, log, p, undefined, () => t)).outcome).toBe('no_match');
    expect(p.calls).toBe(1);
    expect(await hadIdentityRequestRecently(env.DB, SITE_ID, vid, DAY_MS, t, 'delivr')).toBe(true);

    const second = visitRow(vid, recent, { session_id: first.session_id });
    await insertVisit(env.DB, second);
    expect(await processVisit(env, second.id, log, p, undefined, () => t)).toMatchObject({ outcome: 'skipped', skipReason: 'deduped_24h' });
    expect(p.calls).toBe(1);

    // A day later the same visitor may be asked about again.
    const later = t + DAY_MS + 10 * 60_000;
    const third = visitRow(vid, later - 20 * 60_000, { session_id: first.session_id });
    await insertVisit(env.DB, third);
    expect((await processVisit(env, third.id, log, p, undefined, () => later)).outcome).toBe('no_match');
    expect(p.calls).toBe(2);
  });

  it('leaves the free mock provider alone: no engagement gate, no caps, no 24-hour rule', async () => {
    await seedSpend(124_999, NOW - 60_000);
    const v = visitRow(uuidFrom(27), old);
    await insertVisit(env.DB, v);
    const free = { name: 'mock', async resolve(): Promise<ResolveResult> { return { status: 'no_match' }; } };
    expect((await processVisit(env, v.id, log, free, undefined, () => NOW)).outcome).toBe('no_match');
  });
});

describe('spend alerts', () => {
  it('emails 50% and 80% once each per month, in order, and not again', async () => {
    const sender = new FakeSender();
    const alerter = new SpendAlerter({ sender, from: 'Yardsign <leads@mail.tryyardsign.com>', to: 'ops@example.com', adminUrl: 'https://tryyardsign.com/admin' });
    expect(await alerter.checkThresholds(env.DB, log, 62_000, CAPS, NOW)).toEqual([]); // 49.6%
    expect(await alerter.checkThresholds(env.DB, log, 62_500, CAPS, NOW)).toEqual(['Yardsign: Delivr spend at 50% of $1,250 cap']);
    expect(await alerter.checkThresholds(env.DB, log, 70_000, CAPS, NOW)).toEqual([]);
    expect(await alerter.checkThresholds(env.DB, log, 101_000, CAPS, NOW)).toEqual(['Yardsign: Delivr spend at 80% of $1,250 cap']);
    expect(await alerter.checkThresholds(env.DB, log, 120_000, CAPS, NOW)).toEqual([]);
    expect(sender.sent.map((m) => m.to)).toEqual(['ops@example.com', 'ops@example.com']);
    expect(sender.sent[0]?.text).toContain('$625');
    expect(sender.sent[0]?.text).toContain('https://tryyardsign.com/admin');
    expect(sender.sent[0]?.html).toContain('<p>');
    // A new month starts fresh.
    const nov = Date.UTC(2026, 10, 2);
    expect(await alerter.checkThresholds(env.DB, log, 70_000, CAPS, nov)).toHaveLength(1);
    expect(ALERT_PERCENTS).toEqual([50, 80]);
  });

  it('sends the cap-hit emails once per month and once per day', async () => {
    const sender = new FakeSender();
    const alerter = new SpendAlerter({ sender, from: 'f@x', to: 't@x' });
    expect(await alerter.monthlyCapHit(env.DB, log, 125_000, CAPS, NOW)).toBe(true);
    expect(await alerter.monthlyCapHit(env.DB, log, 125_000, CAPS, NOW + DAY_MS)).toBe(false);
    expect(await alerter.dailyCapHit(env.DB, log, 1_000, CAPS, NOW)).toBe(true);
    expect(await alerter.dailyCapHit(env.DB, log, 1_000, CAPS, NOW + 60_000)).toBe(false);
    expect(await alerter.dailyCapHit(env.DB, log, 1_000, CAPS, NOW + DAY_MS)).toBe(true);
    expect(sender.sent.map((m) => m.subject)).toEqual([
      'Yardsign: Delivr monthly cap hit ($1,250). Calls paused until November 1',
      'Yardsign: Delivr daily cap hit ($10). Calls paused until midnight UTC',
      'Yardsign: Delivr daily cap hit ($10). Calls paused until midnight UTC',
    ]);
  });

  it('retries a threshold whose email failed, and logs instead of sending when no sender exists', async () => {
    const down = new SpendAlerter({ sender: new FakeSender(true), from: 'f@x', to: 't@x' });
    expect(await down.checkThresholds(env.DB, log, 62_500, CAPS, NOW)).toEqual([]);
    const up = new FakeSender();
    const okAlerter = new SpendAlerter({ sender: up, from: 'f@x', to: 't@x' });
    expect(await okAlerter.checkThresholds(env.DB, log, 62_500, CAPS, NOW)).toHaveLength(1);
    expect(up.sent).toHaveLength(1);

    const quiet = new SpendAlerter({ sender: null, from: '', to: '' });
    expect(await quiet.dailyCapHit(env.DB, log, 1_000, CAPS, NOW)).toBe(true);
    expect(await quiet.dailyCapHit(env.DB, log, 1_000, CAPS, NOW)).toBe(false);
  });
});
