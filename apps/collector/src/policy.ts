/**
 * Who we try to identify, and whose lead we deliver. The one place these rules live.
 * The pixel route (gate 1), the resolution step (gate 1 again, on the stored visit) and lead
 * delivery (gates 2 and 3) all call this file, so they can never disagree.
 *
 * Decided Oct 7, 2026: identify Texas residents only. Loosened Oct 8 (The owner: stop blocking
 * ourselves; someone browsing from Texas is a Texas resident). What is left:
 *   Gate 1, before Delivr's script loads: not a known bot, no GPC (Delivr drops GPC anyway), US,
 *   and not a visit from a known state outside ALLOWED_STATES. An unknown region passes.
 *   Gate 2, before a lead is delivered: the home address OR the visit is in ALLOWED_STATES.
 *   Gate 3, before a lead is delivered: not opted out, and no GPC on the visit.
 * Data-center networks are no longer dropped: that class holds iCloud Private Relay, Cloudflare
 * WARP, Google Fi and office VPNs, which are people, and a lookup with no match is free.
 */
import type { AsnClass } from '@yardsign/db';
import { isBot } from './bots';

/** The states whose residents we identify. Adding a state is a one-line change here. */
export const ALLOWED_STATES: readonly string[] = ['TX'];

/** ALLOWED_STATES, or a comma list in env.ALLOWED_STATES when a test sets one. Production leaves it unset. */
export function allowedStates(env?: { ALLOWED_STATES?: string }): readonly string[] {
  const raw = (env?.ALLOWED_STATES ?? '').trim();
  if (!raw) return ALLOWED_STATES;
  return raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
}

const STATE_NAMES: Record<string, string> = {
  ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA', COLORADO: 'CO', CONNECTICUT: 'CT',
  DELAWARE: 'DE', 'DISTRICT OF COLUMBIA': 'DC', FLORIDA: 'FL', GEORGIA: 'GA', HAWAII: 'HI', IDAHO: 'ID', ILLINOIS: 'IL',
  INDIANA: 'IN', IOWA: 'IA', KANSAS: 'KS', KENTUCKY: 'KY', LOUISIANA: 'LA', MAINE: 'ME', MARYLAND: 'MD',
  MASSACHUSETTS: 'MA', MICHIGAN: 'MI', MINNESOTA: 'MN', MISSISSIPPI: 'MS', MISSOURI: 'MO', MONTANA: 'MT',
  NEBRASKA: 'NE', NEVADA: 'NV', 'NEW HAMPSHIRE': 'NH', 'NEW JERSEY': 'NJ', 'NEW MEXICO': 'NM', 'NEW YORK': 'NY',
  'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND', OHIO: 'OH', OKLAHOMA: 'OK', OREGON: 'OR', PENNSYLVANIA: 'PA',
  'RHODE ISLAND': 'RI', 'SOUTH CAROLINA': 'SC', 'SOUTH DAKOTA': 'SD', TENNESSEE: 'TN', TEXAS: 'TX', UTAH: 'UT',
  VERMONT: 'VT', VIRGINIA: 'VA', WASHINGTON: 'WA', 'WEST VIRGINIA': 'WV', WISCONSIN: 'WI', WYOMING: 'WY',
};

/** A two-letter US state code, or null. A full name like "Texas" maps to its code (Delivr sometimes fills only the name). */
export function stateCode(value: string | null | undefined): string | null {
  const s = (value ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (/^[A-Z]{2}$/.test(s)) return s;
  return STATE_NAMES[s] ?? null;
}

/** Why gate 1 said no. Stored as visits.skip_reason. */
export type IdentityGateReason = 'bot_or_datacenter' | 'gpc' | 'non_us' | 'region_unknown' | 'not_allowed_state';

/** Why gates 2 and 3 said no. Also stored as visits.skip_reason. */
export type LeadGateReason = 'opted_out' | 'gpc' | 'no_address_state' | 'out_of_state_address';

export type GateResult<R> = { ok: true; reason: null } | { ok: false; reason: R };

const pass = { ok: true, reason: null } as const;

export interface CostSignals {
  asnClass: AsnClass;
  /** True when the user agent, bot score or verified-bot flag says this is not a person. */
  bot?: boolean;
}

/** The cost filter: true means drop it. Not a privacy rule. Only known bots (user agent, bot score, verified-bot flag). */
export function costFilter(s: CostSignals): boolean {
  return s.bot === true;
}

export interface IdentitySignals extends CostSignals {
  /** Sec-GPC: 1 on the request (or stored on the visit). */
  gpc: boolean;
  /** request.cf.country */
  country: string | null;
  /** request.cf.regionCode */
  region: string | null;
}

/**
 * Gate 1. May we load Delivr for this visit (and later ask Delivr about it)?
 * The cost filter runs first so a bot never shows up in the privacy counts. An unknown region
 * (common on cell data and IPv6) passes; gate 2 looks at the matched address.
 */
export function identityGate(s: IdentitySignals, allowed: readonly string[] = ALLOWED_STATES): GateResult<IdentityGateReason> {
  if (costFilter(s)) return { ok: false, reason: 'bot_or_datacenter' };
  if (s.gpc) return { ok: false, reason: 'gpc' };
  if ((s.country ?? '').toUpperCase() !== 'US') return { ok: false, reason: 'non_us' };
  const code = stateCode(s.region);
  if (!code) return pass;
  if (!allowed.includes(code)) return { ok: false, reason: 'not_allowed_state' };
  return pass;
}

/** Gate 1 straight from a request's context: the pixel route uses this. */
export function requestGate(
  ctx: { gpc: boolean; country: string | null; region: string | null; userAgent: string | null; botScore: number | null; verifiedBot: boolean; asnClass: AsnClass },
  allowed: readonly string[] = ALLOWED_STATES,
): GateResult<IdentityGateReason> {
  const bot = isBot({ userAgent: ctx.userAgent, botScore: ctx.botScore, verifiedBot: ctx.verifiedBot });
  return identityGate({ bot, asnClass: ctx.asnClass, gpc: ctx.gpc, country: ctx.country, region: ctx.region }, allowed);
}

export interface LeadSignals {
  /** The resolved home address state. */
  state: string | null;
  /** The person's email is on the opt-out list. */
  optedOut: boolean;
  /** The visit record carries GPC. */
  gpc: boolean;
  /** Where the visit came from (Cloudflare region). Someone browsing from Texas counts as a Texas resident. */
  visitRegion?: string | null;
}

/**
 * Gates 2 and 3. May this lead be delivered anywhere (email, Slack, webhook, GoHighLevel, dashboard)?
 * Yes when the home address is in an allowed state, or when the visit came from one, so a missing
 * or out-of-state address no longer blocks a lead from a Texas visit.
 */
export function leadGate(l: LeadSignals, allowed: readonly string[] = ALLOWED_STATES): GateResult<LeadGateReason> {
  if (l.optedOut) return { ok: false, reason: 'opted_out' };
  if (l.gpc) return { ok: false, reason: 'gpc' };
  const code = stateCode(l.state);
  if (code && allowed.includes(code)) return pass;
  const visit = stateCode(l.visitRegion);
  if (visit && allowed.includes(visit)) return pass;
  return { ok: false, reason: code ? 'out_of_state_address' : 'no_address_state' };
}

/** How long we keep the person fields of a lead we withheld (gate 2), then they are scrubbed. */
export const WITHHELD_RETENTION_DAYS = 30;
