/**
 * The hail box on the lead card. Facts first: size, distance, how long ago, where it was
 * reported. The 0-100 score is shown small so leads can be ranked. No advice on what to do.
 */
import type { HailEventRow, LeadScoreRow } from '@yardsign/db';
import { SCORING, type ScoreComponents, type ScoreResult } from '@yardsign/scoring';

const HOUR_MS = 60 * 60 * 1000;

export type HailFacts =
  | {
      kind: 'found';
      inches: number;
      miles: number;
      at: number;
      /** e.g. "2 mi NNE of Plano", from the NWS report. */
      place: string | null;
      /** How many other reports fell inside the radius and window. */
      others: number;
      score: number;
      /** True when we measured from the house; false when only the visit's internet location was known. */
      fromHome: boolean;
      source: string;
    }
  | { kind: 'none'; radiusMiles: number; windowDays: number; fromHome: boolean }
  | { kind: 'unknown' };

/** Build the card's facts from a score and the event rows it was scored against. */
export function hailFacts(result: ScoreResult, events: ReadonlyArray<HailEventRow>): HailFacts {
  const c = result.components;
  if (!c.location) return { kind: 'unknown' };
  const fromHome = c.location.source === 'lead';
  const best = c.events[0];
  if (!best) return { kind: 'none', radiusMiles: c.radius_miles, windowDays: c.window_days, fromHome };
  const row = events.find((e) => e.id === best.event_id);
  return {
    kind: 'found',
    inches: best.max_hail_in,
    miles: best.distance_mi,
    at: row?.event_at ?? 0,
    place: row ? placeFrom(row.raw) : null,
    others: c.events.length - 1,
    score: result.score,
    fromHome,
    source: best.source,
  };
}

/**
 * The same facts from a stored lead_scores row, for the dashboard and the leads feed.
 * The report time comes from when it was scored minus how old the hail was then.
 * No place name: that lives on the event row and the list does not need it.
 */
export function hailFactsFromScore(row: Pick<LeadScoreRow, 'score' | 'hail_days_since' | 'hail_max_in' | 'hail_distance_mi' | 'components' | 'scored_at'>): HailFacts {
  let c: Partial<ScoreComponents> = {};
  try {
    c = JSON.parse(row.components) as Partial<ScoreComponents>;
  } catch {
    return { kind: 'unknown' };
  }
  if (!c.location) return { kind: 'unknown' };
  const fromHome = c.location.source === 'lead';
  const best = c.events?.[0];
  if (!best || row.hail_max_in === null || row.hail_days_since === null) {
    return { kind: 'none', radiusMiles: c.radius_miles ?? SCORING.radiusMiles, windowDays: c.window_days ?? SCORING.windowDays, fromHome };
  }
  return {
    kind: 'found',
    inches: row.hail_max_in,
    miles: row.hail_distance_mi ?? best.distance_mi,
    at: Math.round(row.scored_at - row.hail_days_since * 24 * HOUR_MS),
    place: null,
    others: (c.events?.length ?? 1) - 1,
    score: row.score,
    fromHome,
    source: best.source,
  };
}

/** One short line for lists and webhooks: "1.75\" hail · 1.2 mi away · 9 days ago", or the no-hail line. Null when unknown. */
export function hailLine(h: HailFacts | undefined, now: number): string | null {
  if (!h || h.kind === 'unknown') return null;
  if (h.kind === 'none') return `No hail reported within ${h.radiusMiles} mi${h.fromHome ? '' : ' of where they were browsing'} in the last 6 months`;
  return headline(h, now);
}

/** The hail object sent to webhooks and the leads feed. Null when scoring did not run or there was no location. */
export function hailJson(h: HailFacts | undefined, now: number): Record<string, unknown> | null {
  if (!h || h.kind === 'unknown') return null;
  if (h.kind === 'none') return { found: false, radius_mi: h.radiusMiles, window_days: h.windowDays, measured_from: h.fromHome ? 'home' : 'visit', summary: hailLine(h, now) };
  return {
    found: true,
    max_hail_in: h.inches,
    distance_mi: h.fromHome ? h.miles : null,
    measured_from: h.fromHome ? 'home' : 'visit',
    event_at: new Date(h.at).toISOString(),
    days_ago: Math.floor(Math.max(0, now - h.at) / (24 * HOUR_MS)),
    place: h.place,
    other_reports: h.others,
    score: h.score,
    source: h.source === 'noaa' ? 'National Weather Service storm report' : h.source,
    summary: hailLine(h, now),
  };
}

/** "2 NNE Plano" (the NWS way) becomes "2 mi NNE of Plano". */
export function placeFrom(raw: string): string | null {
  let city: unknown;
  try {
    city = (JSON.parse(raw) as { city?: unknown }).city;
  } catch {
    return null;
  }
  if (typeof city !== 'string' || !city.trim()) return null;
  const m = /^(\d+(?:\.\d+)?)\s+([NSEW]{1,3})\s+(.+)$/.exec(city.trim());
  return m ? `${m[1]} mi ${m[2]} of ${m[3]}` : city.trim();
}

export function inchesLabel(inches: number): string {
  return `${Number(inches.toFixed(2))}"`;
}

export function milesLabel(miles: number): string {
  return miles < 0.1 ? 'under 0.1 mi' : `${miles < 10 ? miles.toFixed(1) : Math.round(miles)} mi`;
}

/** "under an hour ago", "6 hours ago", "1 day ago", "23 days ago". */
export function agoLabel(at: number, now: number): string {
  const hours = Math.max(0, (now - at) / HOUR_MS);
  if (hours < 1) return 'under an hour ago';
  if (hours < 48) return `${Math.floor(hours)} hour${Math.floor(hours) === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} days ago`;
}

/** "Oct 7, 11:40 AM CT". Texas time, since Texas is what we serve. */
export function whenLabel(at: number): string {
  const s = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(at));
  return `${s} CT`;
}

/** The short version for the subject line. Null when there is no hail to mention. */
export function hailSubjectBit(h: HailFacts | undefined, now: number): string | null {
  if (!h || h.kind !== 'found') return null;
  return `${inchesLabel(h.inches)} hail ${agoLabel(h.at, now)}`;
}

/** The main line: size, distance, age. */
function headline(h: Extract<HailFacts, { kind: 'found' }>, now: number): string {
  const parts = [`${inchesLabel(h.inches)} hail`];
  if (h.fromHome) parts.push(`${milesLabel(h.miles)} away`);
  parts.push(agoLabel(h.at, now));
  return parts.join(' · ');
}

function details(h: Extract<HailFacts, { kind: 'found' }>): string {
  return [whenLabel(h.at), h.place ? `reported ${h.place}` : '', h.source === 'noaa' ? 'National Weather Service storm report' : ''].filter(Boolean).join(' · ');
}

function extras(h: Extract<HailFacts, { kind: 'found' }>): string {
  const more = h.others > 0 ? `${h.others} more report${h.others === 1 ? '' : 's'} within ${SCORING.radiusMiles} mi in 6 months` : '';
  return [more, `Hail score ${h.score}/100`].filter(Boolean).join(' · ');
}

const NOT_HOME = "We couldn't map the house, so this is measured from where they were browsing.";

export function hailText(h: HailFacts | undefined, now: number): string[] {
  if (!h || h.kind === 'unknown') return [];
  if (h.kind === 'none') return [`Hail:       none reported within ${h.radiusMiles} mi in the last 6 months`, h.fromHome ? '' : `            ${NOT_HOME}`].filter(Boolean);
  return [`Hail:       ${headline(h, now)}`, `            ${details(h)}`, `            ${extras(h)}`, h.fromHome ? '' : `            ${NOT_HOME}`].filter(Boolean);
}

export function hailHtml(h: HailFacts | undefined, now: number, esc: (s: string) => string): string {
  if (!h || h.kind === 'unknown') return '';
  if (h.kind === 'none') {
    const note = h.fromHome ? '' : `<div style="font-size:13px;margin-top:4px">${esc(NOT_HOME)}</div>`;
    return `<div style="border:1px solid #d9e0db;background:#f7f9f7;border-radius:6px;padding:10px 14px;margin-bottom:14px;color:#5b6a62">No hail reported within ${h.radiusMiles} miles in the last 6 months.${note}</div>`;
  }
  // Last two weeks stands out; older hail is still shown, quieter.
  const fresh = now - h.at <= 14 * 24 * HOUR_MS;
  const [border, bg, ink] = fresh ? ['#c2410c', '#fdeee6', '#7a2806'] : ['#c99a2e', '#fbf5e6', '#5a4308'];
  return `<div style="border:1px solid ${border};background:${bg};border-radius:6px;padding:12px 14px;margin-bottom:14px">
      <div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:${ink};margin-bottom:4px">Hail near ${h.fromHome ? 'this home' : 'them'}</div>
      <div style="font-size:18px;font-weight:700;color:#16211b">${esc(headline(h, now))}</div>
      <div style="color:#3b4a42;font-size:14px;margin-top:2px">${esc(details(h))}</div>
      <div style="color:#5b6a62;font-size:13px;margin-top:4px">${esc(extras(h))}</div>
      ${h.fromHome ? '' : `<div style="color:#5b6a62;font-size:13px;margin-top:4px">${esc(NOT_HOME)}</div>`}
    </div>`;
}
