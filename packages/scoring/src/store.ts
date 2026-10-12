import { insertLeadScore, listHailEventsInBox, upsertHailEvents, type HailEventRow, type LeadRow, type VisitRow } from '@yardsign/db';
import { boundingBox } from './geo';
import { SCORING, scoreVisit, scoringLocation, type ScoreResult } from './score';
import type { BoundingBox, HailSource } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Find nearby events in D1, score, and write a lead_scores row. Returns the result, the row id and the events it looked at. */
export async function scoreAndStore(
  db: D1Database,
  visit: VisitRow,
  lead: LeadRow | null,
  now = Date.now(),
  /** Only read events from this source (the configured one). Null reads every source. */
  source: string | null = null,
): Promise<{ result: ScoreResult; scoreId: string; events: HailEventRow[] }> {
  const location = scoringLocation({ visit, lead });
  const events = location
    ? await listHailEventsInBox(db, boundingBox(location.lat, location.lng, SCORING.radiusMiles), now - SCORING.windowDays * DAY_MS, source)
    : [];
  const result = scoreVisit({ visit, lead, events, now });
  const scoreId = await insertLeadScore(
    db,
    {
      lead_id: lead?.id ?? null,
      visit_id: visit.id,
      score: result.score,
      hail_days_since: result.hail_days_since,
      hail_max_in: result.hail_max_in,
      hail_distance_mi: result.hail_distance_mi,
      components: JSON.stringify(result.components),
    },
    now,
  );
  return { result, scoreId, events };
}

/** Pull events from a source and upsert them. The hail cron and the admin sync button call this. */
export async function syncHailEvents(db: D1Database, source: HailSource, bbox: BoundingBox, since: Date, now = Date.now()): Promise<number> {
  const events = await source.fetchEvents(bbox, since);
  return upsertHailEvents(
    db,
    events.map((e) => ({
      source: e.source,
      external_id: e.external_id,
      event_at: e.event_at,
      lat: e.lat,
      lng: e.lng,
      geom: e.geom === null ? null : JSON.stringify(e.geom),
      max_hail_in: e.max_hail_in,
      severity: e.severity,
      state: e.state,
      county: e.county,
      zip: e.zip,
      raw: JSON.stringify(e.raw ?? {}),
    })),
    now,
  );
}
