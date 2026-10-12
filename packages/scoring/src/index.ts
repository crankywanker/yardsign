export * from './types';
export { haversineMiles, boundingBox, DFW_BBOX } from './geo';
export { MockHailSource, severityFor } from './sources/mock';
export { NoaaHailSource, parseLsrFeatures, LSR_URL, NOAA_ID_PREFIX } from './sources/noaa';
export { CensusGeocoder, NoGeocoder, getGeocoder, CENSUS_GEOCODER_URL, type Geocoder, type GeocodeAddress } from './geocode';
export { SCORING, scoreVisit, scoringLocation, type ScoreInput, type ScoreResult, type ScoreComponents, type ScoredEvent } from './score';
export { scoreAndStore, syncHailEvents } from './store';

import { MockHailSource } from './sources/mock';
import { NoaaHailSource } from './sources/noaa';
import type { HailSource } from './types';

/** Pick the hail source from env. Default is "mock"; production sets "noaa" in wrangler.toml. */
export function getHailSource(env: { HAIL_SOURCE?: string }): HailSource {
  const name = (env.HAIL_SOURCE ?? 'mock').toLowerCase();
  switch (name) {
    case 'mock':
      return new MockHailSource();
    case 'noaa':
      return new NoaaHailSource();
    default:
      throw new Error(`Unknown HAIL_SOURCE "${name}" (expected "mock" or "noaa")`);
  }
}
