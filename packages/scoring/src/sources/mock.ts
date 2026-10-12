import type { BoundingBox, HailEvent, HailSource } from '../types';

const DAY_MS = 24 * 60 * 60 * 1000;

interface MockSpec {
  id: string;
  daysAgo: number;
  lat: number;
  lng: number;
  inches: number;
  city: string;
  county: string;
  zip: string;
}

/**
 * A fixed set of fake hail events across DFW ZIPs with varied ages so scoring has
 * something to chew on: 2 days, 2 weeks, 6 weeks and 4 months ago. Dates are relative
 * to "now" at fetch time, so re-syncing keeps them fresh. The external ids are stable,
 * so the sync upserts instead of duplicating.
 *
 * The last event is not in Texas at all. `wrangler dev` pretends every local request
 * comes from Chicago (ZIP 60608), so without it a local visit never scores above 0.
 */
const SPECS: ReadonlyArray<MockSpec> = [
  { id: 'mock-plano-2d', daysAgo: 2, lat: 33.0603, lng: -96.7489, inches: 1.75, city: 'Plano', county: 'Collin', zip: '75024' },
  { id: 'mock-frisco-2w', daysAgo: 14, lat: 33.1507, lng: -96.8236, inches: 2.0, city: 'Frisco', county: 'Collin', zip: '75034' },
  { id: 'mock-arlington-2w', daysAgo: 15, lat: 32.7357, lng: -97.1081, inches: 1.25, city: 'Arlington', county: 'Tarrant', zip: '76010' },
  { id: 'mock-fortworth-6w', daysAgo: 42, lat: 32.7555, lng: -97.3308, inches: 1.0, city: 'Fort Worth', county: 'Tarrant', zip: '76107' },
  { id: 'mock-denton-6w', daysAgo: 45, lat: 33.2148, lng: -97.1331, inches: 1.5, city: 'Denton', county: 'Denton', zip: '76201' },
  { id: 'mock-dallas-4m', daysAgo: 120, lat: 32.8668, lng: -96.7836, inches: 2.5, city: 'Dallas', county: 'Dallas', zip: '75230' },
  { id: 'mock-mckinney-4m', daysAgo: 125, lat: 33.1972, lng: -96.6398, inches: 1.0, city: 'McKinney', county: 'Collin', zip: '75070' },
  { id: 'mock-localdev-10d', daysAgo: 10, lat: 41.85, lng: -87.65, inches: 1.5, city: 'Chicago (wrangler dev)', county: 'Cook', zip: '60608' },
];

export function severityFor(inches: number): 'minor' | 'moderate' | 'severe' {
  if (inches >= 2) return 'severe';
  if (inches >= 1) return 'moderate';
  return 'minor';
}

export class MockHailSource implements HailSource {
  readonly name = 'mock';

  constructor(private readonly now: () => number = () => Date.now()) {}

  async fetchEvents(bbox: BoundingBox, since: Date): Promise<HailEvent[]> {
    const now = this.now();
    return SPECS.map((s): HailEvent => ({
      source: this.name,
      external_id: s.id,
      event_at: now - s.daysAgo * DAY_MS,
      lat: s.lat,
      lng: s.lng,
      geom: null,
      max_hail_in: s.inches,
      severity: severityFor(s.inches),
      state: s.zip === '60608' ? 'IL' : 'TX',
      county: s.county,
      zip: s.zip,
      raw: { mock: true, city: s.city, days_ago: s.daysAgo },
    })).filter(
      (e) => e.event_at >= since.getTime() && e.lat >= bbox.minLat && e.lat <= bbox.maxLat && e.lng >= bbox.minLng && e.lng <= bbox.maxLng,
    );
  }
}
