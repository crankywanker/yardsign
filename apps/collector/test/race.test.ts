import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { CLAIM_STALE_MS, DAY_MS, completeIdentityRequest, hadIdentityRequestRecently, insertIdentityRequest, insertVisit, sumIdentityCostSince, type NewVisit } from '@yardsign/db';
import type { IdentityProvider, ResolveResult } from '@yardsign/identity';
import { createLogger } from '../src/log';
import { processVisit } from '../src/resolution';
import { SITE_ID, uuidFrom } from './helpers';

const log = createLogger({ req_id: 'test' });
/** Wednesday Oct 7, 2026, 15:00 UTC. */
const NOW = Date.UTC(2026, 9, 7, 15, 0, 0);

function visitRow(visitorId: string, createdAt: number, over: Partial<NewVisit> = {}): NewVisit {
  return {
    id: crypto.randomUUID(), site_id: SITE_ID, visitor_id: visitorId, session_id: 'sess_' + visitorId.slice(0, 8), url: 'http://localhost:3000/', path: '/',
    referrer: null, title: null, ip_hash: 'h', ip_raw: '203.0.113.10', country: 'US', region: 'TX', city: 'Plano', postal: '75024', asn: 7018, colo: 'DFW',
    lat: 33.0198, lng: -96.6989, user_agent: 'Mozilla/5.0', device: '{}', screen: '{}', timezone: 'America/Chicago', language: 'en-US', bot_score: null,
    occurred_at: createdAt, created_at: createdAt, gpc: 0, asn_org: 'AT&T', asn_class: 'residential', ...over,
  };
}

const MATCH: ResolveResult = {
  status: 'resolved', confidence: 0.9, cost_cents: 2.5, raw: { rows: 1 },
  lead: { first_name: 'Ann', last_name: 'Lee', address_line1: '1 Main St', city: 'Plano', state: 'TX', zip: '75024', email: 'ann@example.com' },
};

/** A paid provider (looks like Delivr to the spend rules) that takes a moment to answer and counts its calls. */
function slowPaid(result: ResolveResult = MATCH, ms = 30): IdentityProvider & { calls: number } {
  const p = {
    name: 'delivr',
    maxCostCentsPerCall: 2.5,
    calls: 0,
    async resolve(): Promise<ResolveResult> {
      p.calls++;
      await new Promise((r) => setTimeout(r, ms));
      return result;
    },
  };
  return p;
}

const count = async (sql: string): Promise<number> => (await env.DB.prepare(sql).first<{ n: number }>())?.n ?? 0;
const attemptedAt = async (id: string) => (await env.DB.prepare('SELECT resolve_attempted_at AS t, skip_reason AS r FROM visits WHERE id = ?').bind(id).first<{ t: number | null; r: string | null }>());
const old = NOW - 20 * 60_000;

describe('two runs at once', () => {
  it('on the same visit: one paid call, one lead; the other run backs off', async () => {
    const v = visitRow(uuidFrom(1), old);
    await insertVisit(env.DB, v);
    const p = slowPaid();
    const results = await Promise.all([processVisit(env, v.id, log, p, undefined, () => NOW), processVisit(env, v.id, log, p, undefined, () => NOW)]);
    expect(results.map((r) => r.outcome).sort()).toEqual(['busy', 'resolved']);
    expect(p.calls).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM identity_requests')).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM leads')).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM deliveries')).toBe(1);
  });

  it('on two visits of one visitor: one paid call; the loser stays open and is deduped later', async () => {
    const vid = uuidFrom(2);
    const a = visitRow(vid, old);
    const b = visitRow(vid, old + 60_000);
    await insertVisit(env.DB, a);
    await insertVisit(env.DB, b);
    const p = slowPaid();
    const [ra, rb] = await Promise.all([processVisit(env, a.id, log, p, undefined, () => NOW), processVisit(env, b.id, log, p, undefined, () => NOW)]);
    expect([ra.outcome, rb.outcome].sort()).toEqual(['busy', 'resolved']);
    expect(p.calls).toBe(1);
    const loser = ra.outcome === 'busy' ? a : b;
    expect((await attemptedAt(loser.id))?.t).toBeNull(); // not marked: a later run decides it
    expect((await processVisit(env, loser.id, log, p, undefined, () => NOW)).outcome).toBe('deduped');
    expect(p.calls).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM leads')).toBe(1);
  });

  it('the free mock path is claimed too: no second fake lead', async () => {
    const v = visitRow(uuidFrom(3), old);
    await insertVisit(env.DB, v);
    let calls = 0;
    const free: IdentityProvider = { name: 'stub', async resolve() { calls++; await new Promise((r) => setTimeout(r, 30)); return MATCH; } };
    const results = await Promise.all([processVisit(env, v.id, log, free, undefined, () => NOW), processVisit(env, v.id, log, free, undefined, () => NOW)]);
    expect(results.map((r) => r.outcome).sort()).toEqual(['busy', 'resolved']);
    expect(calls).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM leads')).toBe(1);
  });
});

describe('a run that stopped halfway', () => {
  it('mid-call (request still pending): no second payment, and the first counts at the worst case', async () => {
    const v = visitRow(uuidFrom(10), old);
    await insertVisit(env.DB, v);
    await insertIdentityRequest(env.DB, { visitId: v.id, provider: 'delivr', requestPayload: {} }, NOW - 60_000);
    const p = slowPaid();
    // While the call could still be in flight, the visit is left alone.
    expect((await processVisit(env, v.id, log, p, undefined, () => NOW)).outcome).toBe('busy');
    expect((await attemptedAt(v.id))?.t).toBeNull();
    expect(await sumIdentityCostSince(env.DB, 'delivr', Date.UTC(2026, 9, 7), 3)).toBe(3);
    // Once it is stale, the dead call counts as billed for the 24-hour rule: still no second payment.
    const later = NOW - 60_000 + CLAIM_STALE_MS + 1;
    expect(await hadIdentityRequestRecently(env.DB, SITE_ID, v.visitor_id, DAY_MS, NOW, 'delivr')).toBe(false);
    expect(await hadIdentityRequestRecently(env.DB, SITE_ID, v.visitor_id, DAY_MS, later, 'delivr')).toBe(true);
    expect(await processVisit(env, v.id, log, p, undefined, () => later)).toMatchObject({ outcome: 'skipped', skipReason: 'deduped_24h' });
    expect(p.calls).toBe(0);
  });

  it('a stale pending row of the free mock does not block it forever', async () => {
    const v = visitRow(uuidFrom(11), old);
    await insertVisit(env.DB, v);
    await insertIdentityRequest(env.DB, { visitId: v.id, provider: 'stub', requestPayload: {} }, NOW - CLAIM_STALE_MS - 1);
    const free: IdentityProvider = { name: 'stub', async resolve() { return { status: 'no_match' }; } };
    expect((await processVisit(env, v.id, log, free, undefined, () => NOW)).outcome).toBe('no_match');
  });

  it('after the match was stored but before the lead (old code): flagged, never paid again', async () => {
    const v = visitRow(uuidFrom(12), old);
    await insertVisit(env.DB, v);
    const id = await insertIdentityRequest(env.DB, { visitId: v.id, provider: 'delivr', requestPayload: {} }, NOW - 60_000);
    await completeIdentityRequest(env.DB, id, { status: 'resolved', responsePayload: { row: { first_name: 'Ann' } }, costCents: 3 }, NOW - 60_000);
    const p = slowPaid();
    expect(await processVisit(env, v.id, log, p, undefined, () => NOW)).toMatchObject({ outcome: 'skipped', skipReason: 'unfinished_match' });
    expect(p.calls).toBe(0);
    expect((await attemptedAt(v.id))?.r).toBe('unfinished_match');
  });

  it('writes the answer, the lead and the visit mark together or not at all', async () => {
    const v = visitRow(uuidFrom(13), old);
    await insertVisit(env.DB, v);
    const p = slowPaid(MATCH, 0);
    const failingBatch = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === 'batch') return async () => { throw new Error('d1: batch failed'); };
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(processVisit({ ...env, DB: failingBatch }, v.id, log, p, undefined, () => NOW)).rejects.toThrow(/batch failed/);
    expect(await count("SELECT COUNT(*) AS n FROM identity_requests WHERE status = 'pending'")).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM leads')).toBe(0);
    expect((await attemptedAt(v.id))?.t).toBeNull();
  });
});
