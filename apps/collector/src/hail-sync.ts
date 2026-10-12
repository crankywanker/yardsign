import { deleteHailEventsNotFrom, deleteHailEventsWithOldIds, hasHailEventsFrom } from '@yardsign/db';
import { getHailSource, NOAA_ID_PREFIX, syncHailEvents, type BoundingBox } from '@yardsign/scoring';
import type { Env } from './env';
import type { Logger } from './log';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Texas, with a little room at the edges. We only serve Texas for now. */
export const HAIL_SYNC_BBOX: BoundingBox = { minLat: 25.8, maxLat: 36.6, minLng: -106.7, maxLng: -93.5 };

/** The full window. Scoring and the lead card look back six months. */
export const HAIL_SYNC_LOOKBACK_MS = 180 * DAY_MS;

/** The hourly run only asks for the last few days: new reports, plus late fixes to recent ones. */
export const HAIL_SYNC_RECENT_MS = 3 * DAY_MS;

/**
 * Pull hail from the configured source (HAIL_SOURCE) and store it. With a real source,
 * also delete every row from any other source, so fake mock hail never reaches a real card.
 * For NOAA, also delete rows in the window just synced that still carry the old id (product id
 * first, before Oct 8, 2026): the sync has just stored those reports again under the new id.
 * `purged` counts both kinds of deleted rows.
 */
export async function runHailSync(env: Pick<Env, 'DB' | 'HAIL_SOURCE'>, log: Logger, lookbackMs: number, now = Date.now()): Promise<{ source: string; events: number; purged: number }> {
  const source = getHailSource(env);
  const since = now - lookbackMs;
  const events = await syncHailEvents(env.DB, source, HAIL_SYNC_BBOX, new Date(since), now);
  const otherSources = source.name === 'mock' ? 0 : await deleteHailEventsNotFrom(env.DB, source.name);
  // Only after a sync that stored something, so an empty answer from a broken feed never empties the table.
  const oldIds = source.name === 'noaa' && events > 0 ? await deleteHailEventsWithOldIds(env.DB, 'noaa', NOAA_ID_PREFIX, since) : 0;
  const purged = otherSources + oldIds;
  log.info('hail: synced', { source: source.name, events, purged, old_ids: oldIds, lookback_days: Math.round(lookbackMs / DAY_MS) });
  return { source: source.name, events, purged };
}

/** How far back the cron asks: the full six months once a day (03:23 UTC) or when the source has no rows yet (first run after a deploy), else 3 days. */
export async function cronLookbackMs(env: Pick<Env, 'DB' | 'HAIL_SOURCE'>, now: number): Promise<number> {
  if (new Date(now).getUTCHours() === 3) return HAIL_SYNC_LOOKBACK_MS;
  return (await hasHailEventsFrom(env.DB, hailSourceName(env))) ? HAIL_SYNC_RECENT_MS : HAIL_SYNC_LOOKBACK_MS;
}

/** Which source scoring reads from. Matches the sync, so rows from an old source are never scored. */
export function hailSourceName(env: Pick<Env, 'HAIL_SOURCE'>): string {
  return getHailSource(env).name;
}
