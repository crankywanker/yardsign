import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DAY_MS, completeIdentityRequest, getVisit, insertIdentityRequest, insertSite, insertVisit, type NewVisit } from '@yardsign/db';
import { CRON_POLL, QUEUE_SWEEP_AGE_MS, runScheduled } from '../src/app';
import type { Env } from '../src/env';
import worker from '../src/index';
import { createLogger } from '../src/log';
import { POLL_MAX_VISITS, pollUnresolvedVisits } from '../src/resolution';
import { queueRetryDelaySeconds, type ResolveMessage } from '../src/scheduler';
import { SITE_ID, uuidFrom } from './helpers';

const log = createLogger({ req_id: 'test' });

function visitRow(siteId: string, visitorId: string, createdAt: number, over: Partial<NewVisit> = {}): NewVisit {
  return {
    id: crypto.randomUUID(), site_id: siteId, visitor_id: visitorId, session_id: 'sess_' + visitorId.slice(0, 8), url: 'http://localhost:3000/', path: '/',
    referrer: null, title: null, ip_hash: 'h', ip_raw: '203.0.113.10', country: 'US', region: 'TX', city: 'Plano', postal: '75024', asn: 7018, colo: 'DFW',
    lat: 33.0198, lng: -96.6989, user_agent: 'Mozilla/5.0', device: '{}', screen: '{}', timezone: 'America/Chicago', language: 'en-US', bot_score: null,
    occurred_at: createdAt, created_at: createdAt, gpc: 0, asn_org: 'AT&T', asn_class: 'residential', ...over,
  };
}

/** A visit gate 1 skips at once (outside the US): cheap to process, and it never reaches a provider. */
const foreign = (siteId: string, n: number, createdAt: number): NewVisit => visitRow(siteId, uuidFrom(n), createdAt, { country: 'MX' });

const unattempted = async (siteId?: string): Promise<number> =>
  (await env.DB.prepare('SELECT COUNT(*) AS n FROM visits WHERE resolve_attempted_at IS NULL AND (? IS NULL OR site_id = ?)').bind(siteId ?? null, siteId ?? null).first<{ n: number }>())?.n ?? 0;

/**
 * Delivr on the test site, with fake keys. Visits younger than 10 minutes are deferred before any
 * call; fetch is stubbed to fail so a test can never reach the real API.
 */
async function delivrEnv(extra: Partial<Env> = {}): Promise<{ denv: Env; fetchSpy: ReturnType<typeof vi.spyOn> }> {
  await env.DB.prepare("UPDATE sites SET delivr_pixel_id = 'pix-12345678' WHERE id = ?").bind(SITE_ID).run();
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in tests'));
  return { denv: { ...env, IDENTITY_PROVIDER: 'delivr', DELIVR_API_KEY: 'k', DELIVR_API_SECRET: 's', ...extra }, fetchSpy };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await env.DB.prepare('UPDATE sites SET delivr_pixel_id = NULL WHERE id = ?').bind(SITE_ID).run();
});

describe('pollUnresolvedVisits', () => {
  it('keeps going past the old 50-visit limit until nothing is left', async () => {
    const t = Date.now() - 60_000;
    for (let i = 0; i < 120; i++) await insertVisit(env.DB, foreign(SITE_ID, i, t + i));
    expect(await pollUnresolvedVisits(env, log, { maxVisits: 500 })).toBe(120);
    expect(await unattempted()).toBe(0);
  });

  it('stops at POLL_MAX_VISITS per run (the query and CPU budget); the rest wait for the next run', async () => {
    const t = Date.now() - 60_000;
    for (let i = 0; i < POLL_MAX_VISITS + 15; i++) await insertVisit(env.DB, foreign(SITE_ID, i, t + i));
    expect(await pollUnresolvedVisits(env, log)).toBe(POLL_MAX_VISITS);
    expect(await unattempted()).toBe(15);
    expect(await pollUnresolvedVisits(env, log)).toBe(15);
  });

  it('goes round-robin across sites, so a flood on one site does not starve another', async () => {
    const other = await insertSite(env.DB, { accountId: 'acct_test', siteKey: 'OTHERSITE', name: 'Other roofer', allowedDomains: ['other.example'] });
    const t = Date.now() - 60 * 60_000;
    for (let i = 0; i < 40; i++) await insertVisit(env.DB, foreign(SITE_ID, i, t + i)); // the flood, all older
    await insertVisit(env.DB, foreign(other.id, 500, t + 1000));
    await insertVisit(env.DB, foreign(other.id, 501, t + 1001));
    // A clock that moves one tick per look: the budget runs out after a handful of visits.
    let tick = 0;
    const n = await pollUnresolvedVisits(env, log, { budgetMs: 6, perSite: 5, clock: () => tick++ });
    expect(n).toBeLessThan(42);
    expect(await unattempted(other.id)).toBe(0);
    expect(await unattempted(SITE_ID)).toBeGreaterThan(0);
  });

  it('looks at a deferred visit once per run instead of spinning on it', async () => {
    const { denv, fetchSpy } = await delivrEnv();
    const t = Date.now() - 60_000; // younger than Delivr's 10 minutes
    for (let i = 0; i < 3; i++) await insertVisit(env.DB, visitRow(SITE_ID, uuidFrom(600 + i), t + i));
    expect(await pollUnresolvedVisits(denv, log, { perSite: 2 })).toBe(3);
    expect(await unattempted()).toBe(3);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('only takes visits older than createdBefore (the queue-mode sweep)', async () => {
    const now = Date.now();
    const stale = foreign(SITE_ID, 700, now - QUEUE_SWEEP_AGE_MS - 60_000);
    const fresh = foreign(SITE_ID, 701, now - 60_000);
    await insertVisit(env.DB, stale);
    await insertVisit(env.DB, fresh);
    expect(await pollUnresolvedVisits(env, log, { createdBefore: now - QUEUE_SWEEP_AGE_MS })).toBe(1);
    expect((await getVisit(env.DB, stale.id))?.resolve_attempted_at).not.toBeNull();
    expect((await getVisit(env.DB, fresh.id))?.resolve_attempted_at).toBeNull();
  });
});

describe('runScheduled', () => {
  it('runs the lookups even when a cleanup step fails, and still runs the other cleanups', async () => {
    const now = Date.now();
    const v = foreign(SITE_ID, 800, now - 60_000);
    await insertVisit(env.DB, v);
    // A withheld match from 40 days ago: the last cleanup step scrubs it.
    const w = foreign(SITE_ID, 801, now - 40 * DAY_MS);
    await insertVisit(env.DB, w);
    await env.DB.prepare('UPDATE visits SET resolve_attempted_at = ? WHERE id = ?').bind(now - 40 * DAY_MS, w.id).run();
    const req = await insertIdentityRequest(env.DB, { visitId: w.id, provider: 'delivr', requestPayload: {} }, now - 40 * DAY_MS);
    await completeIdentityRequest(env.DB, req, { status: 'resolved', responsePayload: { rows: 1, withheld: 'out_of_state_address', row: { first_name: 'X' } }, costCents: 3 });
    // The first cleanup (raw IPs) fails.
    const brokenCleanup = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (sql: string) => {
            if (sql.includes('SET ip_raw = NULL')) throw new Error('d1: update failed');
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await runScheduled({ ...env, DB: brokenCleanup }, CRON_POLL, log, now);
    expect((await getVisit(env.DB, v.id))?.resolve_attempted_at).not.toBeNull();
    const scrubbed = await env.DB.prepare('SELECT response_payload AS p FROM identity_requests WHERE id = ?').bind(req).first<{ p: string }>();
    expect(JSON.parse(scrubbed?.p ?? '{}')).toEqual({ rows: 1, withheld: 'out_of_state_address', scrubbed: 1 });
  });

  it('in queue mode, sweeps only the visits the queue lost', async () => {
    const now = Date.now();
    const lost = foreign(SITE_ID, 810, now - QUEUE_SWEEP_AGE_MS - 60_000);
    const fresh = foreign(SITE_ID, 811, now - 60_000);
    await insertVisit(env.DB, lost);
    await insertVisit(env.DB, fresh);
    const queued = { ...env, RESOLVE_QUEUE: { send: async () => undefined } as unknown as Queue<ResolveMessage> };
    await runScheduled(queued, CRON_POLL, log, now);
    expect((await getVisit(env.DB, lost.id))?.resolve_attempted_at).not.toBeNull();
    expect((await getVisit(env.DB, fresh.id))?.resolve_attempted_at).toBeNull();
  });
});

describe('queue consumer', () => {
  function message(visitId: string) {
    const m = { body: { visitId }, acked: 0, retries: [] as Array<{ delaySeconds?: number } | undefined>, ack: () => { m.acked++; }, retry: (o?: { delaySeconds?: number }) => { m.retries.push(o); } };
    return m;
  }
  async function consume(e: Env, m: ReturnType<typeof message>): Promise<void> {
    await worker.queue({ queue: 'yardsign-resolve', messages: [m] } as unknown as MessageBatch<ResolveMessage>, e);
  }

  it('hands a visit too young for Delivr back to the queue for later, instead of dropping it', async () => {
    const { denv, fetchSpy } = await delivrEnv();
    const v = visitRow(SITE_ID, uuidFrom(900), Date.now() - 60_000);
    await insertVisit(env.DB, v);
    const m = message(v.id);
    await consume(denv, m);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(m.acked).toBe(0);
    expect(m.retries).toHaveLength(1);
    const delay = m.retries[0]?.delaySeconds ?? 0;
    expect(delay).toBeGreaterThan(8 * 60); // about the 9 minutes left of Delivr's 10
    expect(delay).toBeLessThanOrEqual(10 * 60);
    expect((await getVisit(env.DB, v.id))?.resolve_attempted_at).toBeNull();
  });

  it('acks a visit it finished', async () => {
    const v = foreign(SITE_ID, 901, Date.now() - 60_000);
    await insertVisit(env.DB, v);
    const m = message(v.id);
    await consume(env, m);
    expect(m.acked).toBe(1);
    expect(m.retries).toHaveLength(0);
  });

  it('waits at least a minute and at most twelve hours', () => {
    expect(queueRetryDelaySeconds(undefined)).toBe(60);
    expect(queueRetryDelaySeconds(5_000)).toBe(60);
    expect(queueRetryDelaySeconds(9 * 60_000 + 1)).toBe(541);
    expect(queueRetryDelaySeconds(48 * 60 * 60_000)).toBe(43_200);
  });
});
