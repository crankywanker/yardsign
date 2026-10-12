/**
 * The last word on a match's confidence, for any provider: does the matched address fit where
 * the visit came from? Cloudflare gives us the visit's state and ZIP. A match in the same ZIP is
 * a little more believable; a match in another state is much less so. Cell data locates the
 * connection more roughly (a carrier's gateway can sit in the next state), so it costs less there.
 * Below the floor, the match does not become a lead. Since Oct 8 the floor is 0: every match is
 * delivered and the card shows how sure we are.
 */
import type { LeadFields, VisitRow } from '@yardsign/db';

export const DEFAULT_MIN_CONFIDENCE = 0;

export function locationAdjusted(
  confidence: number,
  lead: Pick<LeadFields, 'state' | 'zip'>,
  visit: Pick<VisitRow, 'region' | 'postal' | 'asn_class'>,
): { confidence: number; location: 'same_zip' | 'same_state' | 'other_state' | 'unknown' } {
  const leadZip = (lead.zip ?? '').slice(0, 5);
  const visitZip = (visit.postal ?? '').slice(0, 5);
  const leadState = (lead.state ?? '').trim().toUpperCase();
  const visitState = (visit.region ?? '').trim().toUpperCase();
  let delta = 0;
  let location: 'same_zip' | 'same_state' | 'other_state' | 'unknown' = 'unknown';
  if (leadZip && visitZip && leadZip === visitZip) {
    delta = 0.05;
    location = 'same_zip';
  } else if (leadState.length === 2 && visitState.length === 2) {
    if (leadState === visitState) location = 'same_state';
    else {
      delta = visit.asn_class === 'mobile' ? -0.15 : -0.25;
      location = 'other_state';
    }
  }
  const adjusted = Math.max(0, Math.min(0.95, Math.round((confidence + delta) * 100) / 100));
  return { confidence: adjusted, location };
}

/** MIN_CONFIDENCE as a number between 0 and 1, or the default. */
export function minConfidence(value: string | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n < 1 && value !== undefined && value !== '' ? n : DEFAULT_MIN_CONFIDENCE;
}
