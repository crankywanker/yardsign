import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { insertVisit, type NewVisit } from '@yardsign/db';
import { DEFAULT_MIN_CONFIDENCE, locationAdjusted, minConfidence } from '../src/confidence';
import { createLogger } from '../src/log';
import { processVisit } from '../src/resolution';
import { SITE_ID, uuidFrom } from './helpers';

const log = createLogger({ req_id: 'test' });
const plano = { region: 'TX', postal: '75024', asn_class: 'residential' as const };

describe('location check', () => {
  it('adds a little for the same ZIP and takes a lot for another state', () => {
    expect(locationAdjusted(0.7, { state: 'TX', zip: '75024-1234' }, plano)).toEqual({ confidence: 0.75, location: 'same_zip' });
    expect(locationAdjusted(0.7, { state: 'tx', zip: '75093' }, plano)).toEqual({ confidence: 0.7, location: 'same_state' });
    expect(locationAdjusted(0.7, { state: 'OK', zip: '73301' }, plano)).toEqual({ confidence: 0.45, location: 'other_state' });
    expect(locationAdjusted(0.7, {}, plano)).toEqual({ confidence: 0.7, location: 'unknown' });
  });

  it('costs less on cell data, where the connection location is rougher', () => {
    expect(locationAdjusted(0.7, { state: 'OK' }, { ...plano, asn_class: 'mobile' }).confidence).toBe(0.55);
  });

  it('never goes above 0.95 or below 0', () => {
    expect(locationAdjusted(0.95, { state: 'TX', zip: '75024' }, plano).confidence).toBe(0.95);
    expect(locationAdjusted(0.1, { state: 'OK' }, plano).confidence).toBe(0);
  });

  it('reads the floor from the setting', () => {
    expect(minConfidence(undefined)).toBe(DEFAULT_MIN_CONFIDENCE);
    expect(minConfidence('0.4')).toBe(0.4);
    expect(minConfidence('nope')).toBe(DEFAULT_MIN_CONFIDENCE);
    expect(minConfidence('2')).toBe(DEFAULT_MIN_CONFIDENCE);
  });
});

describe('confidence floor in the resolution step', () => {
  function visitRow(vid: string): NewVisit {
    const now = Date.now() - 60_000;
    return {
      id: crypto.randomUUID(), site_id: SITE_ID, visitor_id: vid, session_id: 'sess_floor_test1', url: 'http://localhost:3000/', path: '/',
      referrer: null, title: null, ip_hash: 'h', ip_raw: null, country: 'US', region: 'TX', city: 'Plano', postal: '75024', asn: 7018, colo: 'DFW',
      lat: null, lng: null, user_agent: 'Mozilla/5.0', device: '{}', screen: '{}', timezone: null, language: null, bot_score: null,
      occurred_at: now, created_at: now, gpc: 0, asn_org: 'AT&T', asn_class: 'residential',
    };
  }
  const answer = (lead: Record<string, string>, confidence: number) => ({ name: 'stub', resolve: async () => ({ status: 'resolved' as const, lead, confidence }) });

  it('delivers every match by default (floor 0), drops one below a floor when MIN_CONFIDENCE is set, and keeps an email-only match', async () => {
    const weak = visitRow(uuidFrom(3001));
    await insertVisit(env.DB, weak);
    const r1 = await processVisit({ ...env, MIN_CONFIDENCE: '0.2' }, weak.id, log, answer({ email: 'a@example.com', state: 'TX' }, 0.1));
    expect(r1.outcome).toBe('low_confidence');
    expect(r1.leadId).toBeUndefined();

    const weakToo = visitRow(uuidFrom(3003));
    await insertVisit(env.DB, weakToo);
    const r0 = await processVisit({ ...env, MIN_CONFIDENCE: undefined }, weakToo.id, log, answer({ email: 'c@example.com', state: 'TX' }, 0.1));
    expect(r0.outcome).toBe('resolved');

    const near = visitRow(uuidFrom(3002));
    await insertVisit(env.DB, near);
    const r2 = await processVisit(env, near.id, log, answer({ email: 'b@example.com', state: 'TX', zip: '75024' }, 0.3));
    expect(r2.outcome).toBe('resolved');
    const lead = await env.DB.prepare('SELECT confidence FROM leads WHERE id = ?').bind(r2.leadId).first<{ confidence: number }>();
    expect(lead?.confidence).toBe(0.35);
  });
});
