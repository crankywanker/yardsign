import type { HailSeverity } from '@yardsign/db';

export interface BoundingBox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

/** One reported hail event, as a source returns it. Maps 1:1 onto the hail_events table. */
export interface HailEvent {
  source: string;
  external_id: string;
  event_at: number; // ms since epoch
  lat: number;
  lng: number;
  geom: unknown | null;
  max_hail_in: number;
  severity: HailSeverity | null;
  state: string | null;
  county: string | null;
  zip: string | null;
  raw: unknown;
}

export interface HailSource {
  readonly name: string;
  fetchEvents(bbox: BoundingBox, since: Date): Promise<HailEvent[]>;
}
