import type { BoundingBox, HailEvent, HailSource } from '../types';
import { severityFor } from './mock';

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** The National Weather Service Local Storm Reports, served as GeoJSON by the Iowa Environmental Mesonet. Free, no key. */
export const LSR_URL = 'https://mesonet.agron.iastate.edu/geojson/lsr.geojson';

/** The fields we read from one LSR feature. The feed has more; see the `raw` we keep. */
interface LsrProps {
  type?: string;
  magf?: number | null;
  magnitude?: string | null;
  valid?: string;
  lat?: number;
  lon?: number;
  state?: string | null;
  county?: string | null;
  city?: string | null;
  source?: string | null;
  remark?: string | null;
  wfo?: string | null;
  typetext?: string | null;
  product_id?: string | null;
}

/**
 * Every NOAA external id starts with this. The id is the report itself (office, time, type, place),
 * not the NWS product that carried it, so a correction or re-issue replaces the first copy.
 * Ids stored before Oct 8, 2026 started with the product id; the hail sync removes those.
 */
export const NOAA_ID_PREFIX = 'lsr2:';

/** The same report in any product gets the same id. */
function reportId(p: LsrProps, at: number): string {
  const part = (s: string | null | undefined) => (s ?? '').trim().toUpperCase();
  return NOAA_ID_PREFIX + [part(p.wfo), new Date(at).toISOString(), part(p.typetext), part(p.city), part(p.county), part(p.state)].join('|');
}

/** A product id starts with its issue time (202610032150-KFWD-...), so a later one sorts higher. None sorts lowest. */
function isNewerProduct(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? '') >= (b ?? '');
}

/**
 * NOAA hail from the NWS Local Storm Reports (LSR). Spotters, police and the public call
 * in hail; the local NWS office posts it within hours with a time, a point and a size in
 * inches. We keep only hail ('H') in the states we serve, inside the box.
 *
 * Reports are points, and hail that falls where nobody reports it is missing. NOAA's
 * radar hail maps (MRMS) would fill those gaps later; they need far more processing.
 */
export class NoaaHailSource implements HailSource {
  readonly name = 'noaa';

  constructor(
    private readonly opts: { states?: string[]; fetchFn?: FetchFn; url?: string } = {},
  ) {}

  async fetchEvents(bbox: BoundingBox, since: Date, until = new Date()): Promise<HailEvent[]> {
    const states = (this.opts.states ?? ['TX']).map((s) => s.toUpperCase());
    const url = new URL(this.opts.url ?? LSR_URL);
    url.searchParams.set('states', states.join(','));
    url.searchParams.set('sts', isoMinute(since));
    url.searchParams.set('ets', isoMinute(until));
    // Workers rejects a stored `fetch` ("Illegal invocation"), so wrap it.
    const fetchFn: FetchFn = this.opts.fetchFn ?? ((input, init) => fetch(input, init));
    const res = await fetchFn(url.toString(), { headers: { accept: 'application/geo+json, application/json' } });
    if (!res.ok) throw new Error(`NOAA storm reports: HTTP ${res.status}`);
    const body = (await res.json()) as { features?: Array<{ properties?: LsrProps }> };
    return parseLsrFeatures(body.features ?? [], { states, bbox, since: since.getTime() });
  }
}

/** Turn LSR features into hail events. Exported for tests. */
export function parseLsrFeatures(
  features: ReadonlyArray<{ properties?: LsrProps }>,
  filter: { states: string[]; bbox: BoundingBox; since: number },
): HailEvent[] {
  const out = new Map<string, HailEvent>();
  for (const f of features) {
    const p = f.properties;
    if (!p || p.type !== 'H') continue;
    const inches = typeof p.magf === 'number' ? p.magf : Number.parseFloat(p.magnitude ?? '');
    const at = p.valid ? Date.parse(p.valid) : Number.NaN;
    const lat = p.lat;
    const lng = p.lon;
    if (!(inches > 0) || Number.isNaN(at) || typeof lat !== 'number' || typeof lng !== 'number') continue;
    const state = p.state ? p.state.toUpperCase() : null;
    if (!state || !filter.states.includes(state)) continue;
    if (lat < filter.bbox.minLat || lat > filter.bbox.maxLat || lng < filter.bbox.minLng || lng > filter.bbox.maxLng) continue;
    if (at < filter.since) continue;
    // The feed lists a report once per product that carried it (the first issue, then each
    // correction). Keep the copy from the newest product: it has the fixed size or place.
    const externalId = reportId(p, at);
    const kept = out.get(externalId);
    if (kept && !isNewerProduct(p.product_id, (kept.raw as { product_id?: string | null }).product_id)) continue;
    out.set(externalId, {
      source: 'noaa',
      external_id: externalId,
      event_at: at,
      lat,
      lng,
      geom: null,
      max_hail_in: inches,
      severity: severityFor(inches),
      state,
      county: p.county ?? null,
      zip: null,
      raw: { city: p.city ?? null, county: p.county ?? null, state, valid: p.valid, magnitude: inches, source: p.source ?? null, remark: p.remark ?? null, wfo: p.wfo ?? null, product_id: p.product_id ?? null },
    });
  }
  return [...out.values()];
}

/** IEM wants `2026-10-07T18:00Z`. */
function isoMinute(d: Date): string {
  return `${d.toISOString().slice(0, 16)}Z`;
}
