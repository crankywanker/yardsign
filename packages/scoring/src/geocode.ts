type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface GeocodeAddress {
  address_line1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

export interface Geocoder {
  readonly name: string;
  /** The point for a street address, or null when there is no street or no match. Never throws. */
  geocode(address: GeocodeAddress): Promise<{ lat: number; lng: number } | null>;
}

/** Leaves leads without a point. Scoring then falls back to the visit's location. Used in tests. */
export class NoGeocoder implements Geocoder {
  readonly name = 'none';
  async geocode(): Promise<null> {
    return null;
  }
}

export const CENSUS_GEOCODER_URL = 'https://geocoding.geo.census.gov/geocoder/locations/address';

/**
 * The US Census Bureau geocoder. Free, no key, US addresses only. Gives the point on the
 * street segment, close enough to measure miles to a hail report.
 */
export class CensusGeocoder implements Geocoder {
  readonly name = 'census';

  constructor(private readonly opts: { fetchFn?: FetchFn; url?: string; timeoutMs?: number } = {}) {}

  async geocode(a: GeocodeAddress): Promise<{ lat: number; lng: number } | null> {
    if (!a.address_line1 || !(a.zip || (a.city && a.state))) return null;
    const url = new URL(this.opts.url ?? CENSUS_GEOCODER_URL);
    url.searchParams.set('street', a.address_line1);
    if (a.city) url.searchParams.set('city', a.city);
    if (a.state) url.searchParams.set('state', a.state);
    if (a.zip) url.searchParams.set('zip', a.zip);
    url.searchParams.set('benchmark', 'Public_AR_Current');
    url.searchParams.set('format', 'json');
    // Workers rejects a stored `fetch` ("Illegal invocation"), so wrap it.
    const fetchFn: FetchFn = this.opts.fetchFn ?? ((input, init) => fetch(input, init));
    try {
      const res = await fetchFn(url.toString(), { signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5000) });
      if (!res.ok) return null;
      const body = (await res.json()) as { result?: { addressMatches?: Array<{ coordinates?: { x?: number; y?: number } }> } };
      const c = body.result?.addressMatches?.[0]?.coordinates;
      if (typeof c?.x !== 'number' || typeof c?.y !== 'number') return null;
      return { lat: c.y, lng: c.x };
    } catch {
      return null;
    }
  }
}

/** Pick the geocoder from env. Default is "census"; "none" turns it off. */
export function getGeocoder(env: { GEOCODER?: string }): Geocoder {
  const name = (env.GEOCODER ?? 'census').toLowerCase();
  switch (name) {
    case 'census':
      return new CensusGeocoder();
    case 'none':
      return new NoGeocoder();
    default:
      throw new Error(`Unknown GEOCODER "${name}" (expected "census" or "none")`);
  }
}
