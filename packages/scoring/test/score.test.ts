import { describe, expect, it } from 'vitest';
import type { HailEventRow } from '@yardsign/db';
import { CENSUS_GEOCODER_URL, CensusGeocoder, DFW_BBOX, LSR_URL, MockHailSource, NOAA_ID_PREFIX, NoaaHailSource, SCORING, boundingBox, haversineMiles, parseLsrFeatures, scoreVisit } from '../src';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
// Plano, TX
const HOME = { lat: 33.0198, lng: -96.6989 };

/** Place a point `miles` due east of HOME. */
function eastOf(miles: number): { lat: number; lng: number } {
  const dLng = miles / (69.0 * Math.cos((HOME.lat * Math.PI) / 180));
  return { lat: HOME.lat, lng: HOME.lng + dLng };
}

function event(id: string, daysAgo: number, inches: number, miles: number): HailEventRow {
  const p = eastOf(miles);
  return {
    id,
    source: 'test',
    external_id: id,
    event_at: NOW - daysAgo * DAY_MS,
    lat: p.lat,
    lng: p.lng,
    geom: null,
    max_hail_in: inches,
    severity: null,
    state: 'TX',
    county: null,
    zip: null,
    raw: '{}',
    created_at: NOW,
  };
}

const visit = { lat: HOME.lat, lng: HOME.lng, postal: '75024' };

describe('scoreVisit', () => {
  it('returns 0 with no nearby events', () => {
    const r = scoreVisit({ visit, lead: null, events: [event('far', 10, 2, 40)], now: NOW });
    expect(r.score).toBe(0);
    expect(r.hail_distance_mi).toBeNull();
    expect(r.components.events).toHaveLength(0);
    expect(r.components.level).toBe('zip');
  });

  it('returns 0 with no location at all', () => {
    const r = scoreVisit({ visit: { lat: null, lng: null, postal: null }, lead: null, events: [event('a', 5, 2, 1)], now: NOW });
    expect(r.score).toBe(0);
    expect(r.components.note).toMatch(/no location/);
  });

  it('scores a 2-week-old 2-inch event at 1 mile higher than a 5-month-old 1-inch event at 4 miles', () => {
    const hot = scoreVisit({ visit, lead: null, events: [event('hot', 14, 2, 1)], now: NOW });
    const cold = scoreVisit({ visit, lead: null, events: [event('cold', 150, 1, 4)], now: NOW });
    expect(hot.score).toBeGreaterThan(cold.score);
    expect(hot.score).toBeGreaterThan(70);
    expect(cold.score).toBeLessThan(45);
    expect(cold.score).toBeGreaterThan(0);
  });

  it('ignores events older than six months', () => {
    const r = scoreVisit({ visit, lead: null, events: [event('old', 181, 3, 0.5), event('ancient', 400, 3, 0.5)], now: NOW });
    expect(r.score).toBe(0);
    expect(r.components.events).toHaveLength(0);
  });

  it('counts hail from a few hours ago at full strength', () => {
    const fresh = scoreVisit({ visit, lead: null, events: [event('fresh', 0.25, 2, 1)], now: NOW });
    const week = scoreVisit({ visit, lead: null, events: [event('week', 7, 2, 1)], now: NOW });
    expect(fresh.score).toBeGreaterThan(week.score);
    expect(fresh.score).toBeGreaterThan(80);
  });

  it('still counts hail from four months ago, but lower than last month', () => {
    const recent = scoreVisit({ visit, lead: null, events: [event('recent', 30, 1.5, 2)], now: NOW });
    const old = scoreVisit({ visit, lead: null, events: [event('old', 120, 1.5, 2)], now: NOW });
    expect(old.score).toBeGreaterThan(0);
    expect(recent.score).toBeGreaterThan(old.score);
  });

  it('takes the best single event and keeps the rest in components', () => {
    const r = scoreVisit({ visit, lead: null, events: [event('weak', 50, 0.75, 4.5), event('strong', 3, 2, 0.5)], now: NOW });
    expect(r.components.best_event_id).toBe('strong');
    expect(r.components.events).toHaveLength(2);
    expect(r.hail_max_in).toBe(2);
    expect(r.hail_days_since).toBe(3);
  });

  it('prefers the lead address over the visit location when the lead is geocoded', () => {
    const lead = { lat: eastOf(30).lat, lng: eastOf(30).lng, zip: '75024' };
    const r = scoreVisit({ visit, lead, events: [event('near-visit', 5, 2, 1)], now: NOW });
    expect(r.components.level).toBe('address');
    expect(r.components.location?.source).toBe('lead');
    expect(r.score).toBe(0); // the event is near the visit, not the lead's address
  });

  it('falls back to the visit location when the lead has no coordinates', () => {
    const r = scoreVisit({ visit, lead: { lat: null, lng: null, zip: '75024' }, events: [event('near', 5, 2, 1)], now: NOW });
    expect(r.components.level).toBe('address');
    expect(r.components.location?.source).toBe('visit');
    expect(r.score).toBeGreaterThan(0);
  });
});

describe('geo helpers', () => {
  it('haversine: Dallas to Fort Worth is about 31 miles', () => {
    expect(haversineMiles(32.7767, -96.797, 32.7555, -97.3308)).toBeCloseTo(31, 0);
  });
  it('bounding box contains the radius circle', () => {
    const b = boundingBox(HOME.lat, HOME.lng, SCORING.radiusMiles);
    const p = eastOf(SCORING.radiusMiles);
    expect(p.lng).toBeLessThanOrEqual(b.maxLng);
    expect(p.lng).toBeGreaterThanOrEqual(b.minLng);
  });
});

describe('hail sources', () => {
  it('mock returns DFW events at the expected ages', async () => {
    const src = new MockHailSource(() => NOW);
    const events = await src.fetchEvents(DFW_BBOX, new Date(NOW - 365 * DAY_MS));
    const ages = events.map((e) => Math.round((NOW - e.event_at) / DAY_MS)).sort((a, b) => a - b);
    expect(ages).toContain(2);
    expect(ages).toContain(14);
    expect(ages).toContain(42);
    expect(ages).toContain(120);
    for (const e of events) expect(e.state).toBe('TX'); // the DFW box leaves out the local-dev event
  });
  it('mock respects the since filter', async () => {
    const src = new MockHailSource(() => NOW);
    const events = await src.fetchEvents(DFW_BBOX, new Date(NOW - 30 * DAY_MS));
    for (const e of events) expect(NOW - e.event_at).toBeLessThanOrEqual(30 * DAY_MS);
  });
});

/** One LSR feature the way the Iowa Environmental Mesonet serves it. */
function lsr(over: Record<string, unknown> = {}): { properties: Record<string, unknown> } {
  return {
    properties: {
      type: 'H', magf: 1.75, magnitude: '1.75', valid: '2026-10-03T21:40:00Z', lat: 33.05, lon: -96.7, state: 'TX', county: 'Collin',
      city: '2 NNE Plano', source: 'Trained Spotter', remark: 'Golf ball hail.', wfo: 'FWD', product_id: '202610032150-KFWD-NWUS54-LSRFWD',
      ...over,
    },
  };
}

describe('NOAA storm reports', () => {
  const since = Date.UTC(2026, 3, 1);
  const filter = { states: ['TX'], bbox: DFW_BBOX, since };

  it('keeps hail in Texas inside the box and maps it to a hail event', () => {
    const [e, ...rest] = parseLsrFeatures([lsr()], filter);
    expect(rest).toHaveLength(0);
    expect(e).toMatchObject({ source: 'noaa', lat: 33.05, lng: -96.7, max_hail_in: 1.75, severity: 'moderate', state: 'TX', county: 'Collin', zip: null });
    expect(e?.event_at).toBe(Date.parse('2026-10-03T21:40:00Z'));
    expect((e?.raw as { city: string }).city).toBe('2 NNE Plano');
  });

  it('drops wind, other states, points outside the box, old reports and missing sizes', () => {
    const out = parseLsrFeatures(
      [lsr({ type: 'G' }), lsr({ state: 'OK' }), lsr({ lat: 29.7, lon: -95.4 }), lsr({ valid: '2026-03-01T00:00:00Z' }), lsr({ magf: null, magnitude: '' })],
      filter,
    );
    expect(out).toHaveLength(0);
  });

  it('reads the size from the text field when magf is missing', () => {
    expect(parseLsrFeatures([lsr({ magf: null, magnitude: '2.50' })], filter)[0]?.max_hail_in).toBe(2.5);
  });

  it('gives each report in one NWS product its own id, and dedupes repeats', () => {
    const out = parseLsrFeatures([lsr(), lsr({ lat: 33.1, city: '5 N Plano' }), lsr()], filter);
    expect(out).toHaveLength(2);
    expect(new Set(out.map((e) => e.external_id)).size).toBe(2);
  });

  it('keys a report on what it is, not the product that carried it, and keeps the newest product', () => {
    const first = lsr({ magf: 1, magnitude: '1.00', typetext: 'HAIL' });
    const fixed = lsr({ magf: 1.75, magnitude: '1.75', typetext: 'HAIL', lat: 33.051, product_id: '202610040105-KFWD-NWUS54-LSRFWD' });
    for (const order of [[first, fixed], [fixed, first]]) {
      const out = parseLsrFeatures(order, filter);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ max_hail_in: 1.75, lat: 33.051 });
      expect((out[0]?.raw as { product_id: string }).product_id).toBe('202610040105-KFWD-NWUS54-LSRFWD');
      expect(out[0]?.external_id).toBe(`${NOAA_ID_PREFIX}FWD|2026-10-03T21:40:00.000Z|HAIL|2 NNE PLANO|COLLIN|TX`);
      expect(out[0]?.external_id).not.toContain('202610');
    }
    // A product with no id never wins over one that has an id.
    expect(parseLsrFeatures([lsr(), lsr({ magf: 3, product_id: null })], filter)[0]?.max_hail_in).toBe(1.75);
  });

  it('asks the feed for Texas and the time window', async () => {
    let asked = '';
    const src = new NoaaHailSource({
      fetchFn: async (url) => {
        asked = url;
        return new Response(JSON.stringify({ type: 'FeatureCollection', features: [lsr()] }));
      },
    });
    const out = await src.fetchEvents(DFW_BBOX, new Date(since), new Date(Date.UTC(2026, 9, 7, 18, 5)));
    expect(out).toHaveLength(1);
    const u = new URL(asked);
    expect(u.origin + u.pathname).toBe(LSR_URL);
    expect(u.searchParams.get('states')).toBe('TX');
    expect(u.searchParams.get('sts')).toBe('2026-04-01T00:00Z');
    expect(u.searchParams.get('ets')).toBe('2026-10-07T18:05Z');
  });

  it('throws on a bad response so the sync logs it', async () => {
    const src = new NoaaHailSource({ fetchFn: async () => new Response('down', { status: 503 }) });
    await expect(src.fetchEvents(DFW_BBOX, new Date(since))).rejects.toThrow('HTTP 503');
  });
});

describe('Census geocoder', () => {
  const home = { address_line1: '1520 K Ave', city: 'Plano', state: 'TX', zip: '75074' };
  const match = { result: { addressMatches: [{ coordinates: { x: -96.699, y: 33.0204 } }] } };

  it('returns the point for a matched address', async () => {
    let asked = '';
    const g = new CensusGeocoder({ fetchFn: async (url) => ((asked = url), new Response(JSON.stringify(match))) });
    expect(await g.geocode(home)).toEqual({ lat: 33.0204, lng: -96.699 });
    const u = new URL(asked);
    expect(u.origin + u.pathname).toBe(CENSUS_GEOCODER_URL);
    expect(u.searchParams.get('street')).toBe('1520 K Ave');
    expect(u.searchParams.get('zip')).toBe('75074');
  });

  it('returns null with no street, no match, a bad status or a network error', async () => {
    const ok = new CensusGeocoder({ fetchFn: async () => new Response(JSON.stringify(match)) });
    expect(await ok.geocode({ ...home, address_line1: null })).toBeNull();
    expect(await ok.geocode({ address_line1: '1 Main St', city: null, state: null, zip: null })).toBeNull();
    const none = new CensusGeocoder({ fetchFn: async () => new Response(JSON.stringify({ result: { addressMatches: [] } })) });
    expect(await none.geocode(home)).toBeNull();
    const bad = new CensusGeocoder({ fetchFn: async () => new Response('', { status: 500 }) });
    expect(await bad.geocode(home)).toBeNull();
    const down = new CensusGeocoder({ fetchFn: async () => Promise.reject(new Error('reset')) });
    expect(await down.geocode(home)).toBeNull();
  });
});
