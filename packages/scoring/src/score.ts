import type { HailEventRow, LeadRow, VisitRow } from '@yardsign/db';
import { haversineMiles } from './geo';

/** All the knobs in one place. Change them here and the components JSON still explains old rows. */
export const SCORING = {
  radiusMiles: 5,
  /** Six months. Older hail rarely gets an insurance claim paid (The owner, Oct 7). */
  windowDays: 180,
  /** Hail at or above this many inches counts as "full size". */
  fullSizeInches: 2,
  /** Recency leads: fresh hail is the lead a roofer calls first. */
  weights: { recency: 0.5, closeness: 0.3, size: 0.2 },
  version: 2,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ScoredEvent {
  event_id: string;
  external_id: string;
  source: string;
  days_since: number;
  distance_mi: number;
  max_hail_in: number;
  recency: number;
  closeness: number;
  size: number;
  event_score: number;
}

export interface ScoreComponents {
  version: number;
  level: 'zip' | 'address';
  location: { lat: number; lng: number; source: 'lead' | 'visit' } | null;
  radius_miles: number;
  window_days: number;
  weights: { recency: number; closeness: number; size: number };
  events: ScoredEvent[];
  best_event_id: string | null;
  note?: string;
}

export interface ScoreResult {
  score: number;
  hail_days_since: number | null;
  hail_max_in: number | null;
  hail_distance_mi: number | null;
  components: ScoreComponents;
}

export interface ScoreInput {
  visit: Pick<VisitRow, 'lat' | 'lng' | 'postal'>;
  lead: Pick<LeadRow, 'lat' | 'lng' | 'zip'> | null;
  /** Candidate events, usually from listHailEventsInBox(). Distance and age are checked here. */
  events: ReadonlyArray<HailEventRow>;
  now?: number;
}

/** Where to measure from. The lead's geocoded point when we have one, else the visit's. */
export function scoringLocation(input: Pick<ScoreInput, 'visit' | 'lead'>): ScoreComponents['location'] {
  if (input.lead && input.lead.lat !== null && input.lead.lng !== null) return { lat: input.lead.lat, lng: input.lead.lng, source: 'lead' };
  if (input.visit.lat !== null && input.visit.lng !== null) return { lat: input.visit.lat, lng: input.visit.lng, source: 'visit' };
  return null;
}

/**
 * The formula. For every event within the radius and the window:
 *   event_score = 100 * (w.recency * (1 - days/window) + w.closeness * (1 - miles/radius) + w.size * min(inches/fullSize, 1))
 * The visit's score is the best single event. Closer, more recent and bigger hail all push it up.
 */
export function scoreVisit(input: ScoreInput): ScoreResult {
  const now = input.now ?? Date.now();
  const level: ScoreComponents['level'] = input.lead ? 'address' : 'zip';
  const location = scoringLocation(input);
  const base: ScoreComponents = {
    version: SCORING.version,
    level,
    location,
    radius_miles: SCORING.radiusMiles,
    window_days: SCORING.windowDays,
    weights: { ...SCORING.weights },
    events: [],
    best_event_id: null,
  };
  if (!location) {
    return { score: 0, hail_days_since: null, hail_max_in: null, hail_distance_mi: null, components: { ...base, note: 'no location on visit or lead' } };
  }

  const windowMs = SCORING.windowDays * DAY_MS;
  const scored: ScoredEvent[] = [];
  for (const e of input.events) {
    const ageMs = now - e.event_at;
    if (ageMs < 0 || ageMs > windowMs) continue;
    const distance = haversineMiles(location.lat, location.lng, e.lat, e.lng);
    if (distance > SCORING.radiusMiles) continue;
    const days = ageMs / DAY_MS;
    const recency = 1 - days / SCORING.windowDays;
    const closeness = 1 - distance / SCORING.radiusMiles;
    const size = Math.min(e.max_hail_in / SCORING.fullSizeInches, 1);
    const eventScore = 100 * (SCORING.weights.recency * recency + SCORING.weights.closeness * closeness + SCORING.weights.size * size);
    scored.push({
      event_id: e.id,
      external_id: e.external_id,
      source: e.source,
      days_since: round(days, 2),
      distance_mi: round(distance, 2),
      max_hail_in: e.max_hail_in,
      recency: round(recency, 3),
      closeness: round(closeness, 3),
      size: round(size, 3),
      event_score: round(eventScore, 1),
    });
  }
  scored.sort((a, b) => b.event_score - a.event_score);
  const best = scored[0];
  if (!best) {
    return { score: 0, hail_days_since: null, hail_max_in: null, hail_distance_mi: null, components: { ...base, events: [] } };
  }
  return {
    score: Math.max(0, Math.min(100, Math.round(best.event_score))),
    hail_days_since: best.days_since,
    hail_max_in: best.max_hail_in,
    hail_distance_mi: best.distance_mi,
    components: { ...base, events: scored, best_event_id: best.event_id },
  };
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}
