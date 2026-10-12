import type { IdentityProvider, LeadFields, ResolveInput, ResolveResult } from './types';

/**
 * Delivr.ai adapter. Read docs/DELIVR.md first.
 *
 * Delivr does not resolve an IP address. Their pixel runs on the customer's page (our pixel
 * loads it, see packages/pixel), sets a Delivr cookie, and matches it against their identity
 * graph. Every page view becomes an event; a matched one carries the person's fields. We
 * find the event for a visit by asking for resolved events on that site's pixel, in a time
 * window around the visit, filtered to our own visitor id: our pixel tags each Delivr event
 * with it (`ys_vid` in event_data), and Delivr's `like` operator matches it as a substring.
 * The IP is only a fallback join key. It cannot be the main one: the first real iPhone visit
 * (Oct 7) reached our collector over IPv6 while Delivr recorded it under IPv4.
 *
 * Billing: every row Delivr returns from this tier costs one full-profile unit ($25 per
 * 1,000 in the first band = 2.5 cents). An empty result is free. So the query is tight:
 * one pixel, a short window, a visitor-id filter plus resolved:eq:true, and limit 1. Only a
 * resolved event for this exact visitor can come back, so a no-match is free. If rows come back that do not
 * match the visit (which would mean the filter was ignored), the provider stops calling for
 * the rest of the run so a bad filter cannot run up a bill. The monthly and daily spend caps,
 * the engagement gate and the one-call-per-visitor-per-day rule live in the resolution step
 * (apps/collector/src/spend.ts and resolution.ts).
 *
 * The dev key returns sample rows (ip "test_ip_1") for every query, so with it this adapter
 * always ends in no_match. That is expected until the production key is in place.
 */

export const DELIVR_BASE_URL = 'https://api.delivr.ai';
/** Full-profile meter, first volume band: $25 per 1,000 rows. identity_requests rounds to a whole cent. */
export const DELIVR_COST_CENTS = 2.5;
/** Delivr needs a little time after the page view before the event is queryable. */
export const DELIVR_MIN_VISIT_AGE_MS = 10 * 60 * 1000;
/** Window around the visit we search. Events are stamped at page-view time. */
export const DELIVR_WINDOW_BEFORE_MS = 15 * 60 * 1000;
export const DELIVR_WINDOW_AFTER_MS = 2 * 60 * 60 * 1000;
/** Only a well-formed visitor id goes into the filter string; anything else falls back to the IP filter. */
const SAFE_VISITOR_ID = /^[0-9a-f-]{36}$/i;
/** Most rows one call may return (and bill). One: we only ever use the first resolved row anyway. */
export const DELIVR_ROW_LIMIT = 1;
/** The most one call can cost: every row returned is billed. The spend cap counts this before each call. */
export const DELIVR_MAX_COST_CENTS_PER_CALL = DELIVR_ROW_LIMIT * DELIVR_COST_CENTS;
/** After this many calls in a row that return rows which do not match the visit, stop calling. */
export const DELIVR_MISMATCH_TRIP = 3;

/**
 * Every name here must exist in the live resolution_full_profile schema (the "Probe the Delivr
 * account" workflow prints it). The production API rejects the whole query with a 400 "Schema
 * error" on one unknown name; the dev key did not, which is how click_url slipped in (Oct 7).
 * We do not ask for age, income, net worth, marital status or children (dropped Oct 8): we do
 * not use them, and the privacy page says we do not collect information about children.
 */
export const DELIVR_SELECT = [
  'event_id', 'event_type', 'timestamp', 'ip', 'client_ip', 'user_agent', 'cookie_id', 'pixel_id', 'resolved', 'event_data', 'referrer_url',
  'first_name', 'middle_name', 'last_name',
  'personal_address', 'personal_address_2', 'personal_city', 'personal_state', 'personal_state_code', 'personal_zip', 'personal_zip4', 'dpv_code',
  'mobile_phones', 'mobile_phones_dnc', 'personal_phones', 'personal_phones_dnc', 'phones', 'phones_dnc',
  'personal_email', 'personal_emails', 'email', 'is_email_personal',
  'is_homeowner', 'linkedin_url',
].join(',');

/** One row of the resolution_full_profile tier. Only the fields we read are typed; the rest ride along. */
export interface DelivrEventRow {
  event_id?: string;
  event_type?: string;
  timestamp?: number;
  ip?: string | null;
  client_ip?: string | null;
  user_agent?: string | null;
  cookie_id?: string | null;
  pixel_id?: string | null;
  resolved?: boolean | null;
  event_data?: string | null;
  referrer_url?: string | null;
  first_name?: string | null;
  middle_name?: string | null;
  last_name?: string | null;
  personal_address?: string | null;
  personal_address_2?: string | null;
  personal_city?: string | null;
  personal_state?: string | null;
  personal_state_code?: string | null;
  personal_zip?: string | null;
  personal_zip4?: string | null;
  dpv_code?: string | null;
  /** The live schema types the list fields as Utf8: a JSON array as text, or a comma-separated string. The dev sample gave real arrays. list() reads all three. */
  mobile_phones?: string[] | string | null;
  mobile_phones_dnc?: string[] | string | null;
  personal_phones?: string[] | string | null;
  personal_phones_dnc?: string[] | string | null;
  phones?: string[] | string | null;
  phones_dnc?: string[] | string | null;
  personal_email?: string | null;
  personal_emails?: string[] | string | null;
  email?: string | null;
  /** The live schema types the flags as Utf8 ("true"/"false"); the dev sample gave booleans. bool() reads both. */
  is_email_personal?: boolean | string | null;
  is_homeowner?: boolean | string | null;
  linkedin_url?: string | null;
  [key: string]: unknown;
}

export interface DelivrEventsResponse {
  rows?: DelivrEventRow[];
  meta?: Record<string, unknown>;
}

export interface DelivrOptions {
  apiKey: string | undefined;
  apiSecret: string | undefined;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  now?: () => number;
}

function str(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t : undefined;
}

/** A list field: a real array, a JSON array as text, or a comma/semicolon-separated string. */
export function list(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
  if (typeof v !== 'string') return [];
  const t = v.trim();
  if (!t) return [];
  if (t.startsWith('[')) {
    try {
      return list(JSON.parse(t));
    } catch {
      /* not JSON after all; fall through to the split */
    }
  }
  return t.split(/[,;]/).map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

/** A flag field: a real boolean, or "true"/"false"/"1"/"0"/"yes"/"no" as text. Anything else is null (unknown). */
export function bool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 't'].includes(t)) return true;
    if (['false', '0', 'no', 'n', 'f'].includes(t)) return false;
  }
  return null;
}

/** Like list(), but every position stays (a blank entry is ''), so a list of flags lines up with its phones. Booleans and numbers become text. */
function items(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x.trim() : typeof x === 'boolean' || typeof x === 'number' ? String(x) : ''));
  if (typeof v !== 'string') return [];
  const t = v.trim();
  if (!t) return [];
  if (t.startsWith('[')) {
    try {
      return items(JSON.parse(t));
    } catch {
      /* not JSON after all; fall through to the split */
    }
  }
  return t.split(/[,;]/).map((x) => x.trim().replace(/^["']|["']$/g, ''));
}

/** The last 10 digits: "(303) 555-0101", "+1 303-555-0101" and "3035550101" are the same number. */
const phoneKey = (s: string): string => s.replace(/\D/g, '').slice(-10);

/**
 * Is the phone at position `i` on the do-not-call list? Delivr's `*_dnc` field is either the
 * numbers that are on the list (compared by digits, so formatting does not matter) or one
 * yes/no flag per phone, in the same order. No list means no number is known to be on it.
 */
function onDncList(phone: string, i: number, dnc: string[]): boolean {
  const flags = dnc.some((d) => d !== '') && dnc.every((d) => d === '' || bool(d) !== null);
  if (flags) return bool(dnc[i]) === true;
  const key = phoneKey(phone);
  return key ? dnc.some((d) => phoneKey(d) === key) : dnc.includes(phone);
}

/** First phone that is not on a do-not-call list: mobile first, then personal, then any. */
export function pickPhone(row: DelivrEventRow): string | undefined {
  const pairs: Array<[string[], string[]]> = [
    [items(row.mobile_phones), items(row.mobile_phones_dnc)],
    [items(row.personal_phones), items(row.personal_phones_dnc)],
    [items(row.phones), items(row.phones_dnc)],
  ];
  for (const [phones, dnc] of pairs) {
    const ok = phones.find((p, i) => p !== '' && !onDncList(p, i, dnc));
    if (ok) return ok;
  }
  return undefined;
}

/** Personal email first; a business address only if nothing else exists. */
export function pickEmail(row: DelivrEventRow): string | undefined {
  return str(row.personal_email) ?? list(row.personal_emails)[0] ?? str(row.email);
}

/** Every email in the row, personal and business, for the opt-out check. */
export function allEmails(row: DelivrEventRow): string[] {
  const all = [str(row.personal_email), ...list(row.personal_emails), str(row.email)].filter((e): e is string => !!e);
  return [...new Set(all.map((e) => e.toLowerCase()))];
}

/** Every phone in the row, do-not-call ones included, for the opt-out check. */
export function allPhones(row: DelivrEventRow): string[] {
  return [...new Set([...list(row.mobile_phones), ...list(row.personal_phones), ...list(row.phones)])];
}

/** Does this Delivr event belong to the visit we asked about? IP match, or our visitor id in the event data. */
export function rowMatchesVisit(row: DelivrEventRow, input: Pick<ResolveInput, 'ip' | 'visitor_id'>): boolean {
  const ip = input.ip;
  if (ip && (row.ip === ip || row.client_ip === ip)) return true;
  const data = typeof row.event_data === 'string' ? row.event_data : '';
  return data.includes(input.visitor_id);
}

export function mapDelivrRow(row: DelivrEventRow): { lead: LeadFields; confidence: number } {
  const lead: LeadFields = {
    first_name: str(row.first_name),
    last_name: str(row.last_name),
    address_line1: str(row.personal_address),
    address_line2: str(row.personal_address_2),
    city: str(row.personal_city),
    state: str(row.personal_state_code) ?? str(row.personal_state),
    zip: str(row.personal_zip),
    phone: pickPhone(row),
    email: pickEmail(row),
    linkedin_url: str(row.linkedin_url),
    extra: {
      provider: 'delivr',
      event_id: row.event_id ?? null,
      event_type: row.event_type ?? null,
      cookie_id: row.cookie_id ?? null,
      pixel_id: row.pixel_id ?? null,
      is_homeowner: bool(row.is_homeowner),
      dpv_code: row.dpv_code ?? null,
      zip4: row.personal_zip4 ?? null,
      middle_name: row.middle_name ?? null,
    },
  };
  return { lead, confidence: delivrConfidence(lead, row) };
}

/**
 * Confidence from what came back. Delivr gives no match score, so the fields are the evidence:
 * an email alone is weak, a name with a way to reach them is better, a name with a street
 * address is a real household. A USPS-checked address (dpv_code present and not "N"), the
 * homeowner flag and a phone each add a little. The resolution step adjusts for location.
 */
export function delivrConfidence(lead: Pick<LeadFields, 'first_name' | 'last_name' | 'address_line1' | 'phone' | 'email'>, row: Pick<DelivrEventRow, 'dpv_code' | 'is_homeowner'>): number {
  const named = !!(lead.first_name || lead.last_name);
  let confidence = named && lead.address_line1 ? 0.7 : named && (lead.email || lead.phone) ? 0.5 : 0.3;
  const dpv = str(row.dpv_code);
  if (lead.address_line1 && dpv && !dpv.toUpperCase().startsWith('N')) confidence += 0.1;
  if (bool(row.is_homeowner) === true) confidence += 0.05;
  if (lead.phone) confidence += 0.05;
  return Math.min(0.95, Math.round(confidence * 100) / 100);
}

export class DelivrProvider implements IdentityProvider {
  readonly name = 'delivr';
  readonly minVisitAgeMs = DELIVR_MIN_VISIT_AGE_MS;
  readonly maxCostCentsPerCall = DELIVR_MAX_COST_CENTS_PER_CALL;
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;
  private readonly now: () => number;
  /** Consecutive calls that returned rows which did not match the visit. Resets on any match or empty result. */
  private mismatches = 0;

  constructor(private readonly opts: DelivrOptions) {
    this.fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));
    this.baseUrl = (opts.baseUrl ?? DELIVR_BASE_URL).replace(/\/+$/, '');
    this.now = opts.now ?? (() => Date.now());
  }

  get configured(): boolean {
    return Boolean(this.opts.apiKey && this.opts.apiSecret);
  }

  /** The URL one visit's query goes to. Exposed so tests and the setup workflow can see it. */
  queryUrl(input: ResolveInput): string {
    const u = new URL(`${this.baseUrl}/api/v3/events/resolution_full_profile`);
    u.searchParams.set('pixel_id', input.provider_site_id ?? '');
    // The window comes from our server's clock (created_at), never the browser's: a phone whose clock
    // runs 15 minutes fast would otherwise put its own event outside the window.
    u.searchParams.set('start_ms', String(input.created_at - DELIVR_WINDOW_BEFORE_MS));
    u.searchParams.set('end_ms', String(Math.min(this.now(), input.created_at + DELIVR_WINDOW_AFTER_MS)));
    u.searchParams.set('limit', String(DELIVR_ROW_LIMIT));
    u.searchParams.set('select', DELIVR_SELECT);
    // Filter syntax: <field>:<op>:<value>, conditions joined by a comma (tested on the live API, Oct 7).
    // `like` with no wildcard is a substring match, so the visitor id our pixel put into event_data
    // finds exactly this browser's events, whatever IP either side saw. resolved:eq:true means only
    // a matched person can come back, and an empty answer is free. The client-side check in
    // rowMatchesVisit() is still what we trust.
    const byVisitor = SAFE_VISITOR_ID.test(input.visitor_id) ? `event_data:like:${input.visitor_id}` : `ip:eq:${input.ip ?? ''}`;
    u.searchParams.set('filter', `${byVisitor},resolved:eq:true`);
    return u.toString();
  }

  async resolve(input: ResolveInput): Promise<ResolveResult> {
    if (!this.configured) throw new Error('Delivr provider not configured: DELIVR_API_KEY and DELIVR_API_SECRET are required');
    if (!input.provider_site_id) return { status: 'error', error: 'site has no Delivr pixel (sites.delivr_pixel_id is null)' };
    // The visitor id is the join key now, so an expired raw IP no longer blocks the lookup; only a visit with neither does.
    if (!input.ip && !SAFE_VISITOR_ID.test(input.visitor_id)) return { status: 'no_match', raw: { reason: 'no visitor id and the raw ip already expired; nothing to join on' } };
    if (this.mismatches >= DELIVR_MISMATCH_TRIP) {
      return { status: 'error', error: `delivr: ${this.mismatches} calls in a row returned rows that did not match the visit; stopped to protect the bill` };
    }

    let res: Response;
    try {
      res = await this.fetchFn(this.queryUrl(input), {
        method: 'GET',
        headers: { 'X-Api-Key': this.opts.apiKey as string, 'X-Api-Secret': this.opts.apiSecret as string, Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      return { status: 'error', error: `delivr: ${err instanceof Error ? err.message : String(err)}` };
    }
    // A 200 may already be billed even when we never get to read its rows, so a body we cannot
    // read or parse counts at the worst case for this call. The caps must see it.
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      const error = `delivr: reading the response failed: ${err instanceof Error ? err.message : String(err)}`;
      return res.ok ? { status: 'error', error, cost_cents: DELIVR_MAX_COST_CENTS_PER_CALL } : { status: 'error', error };
    }
    if (!res.ok) return { status: 'error', error: `delivr: ${res.status} ${res.statusText}: ${text.slice(0, 300)}`, raw: { status: res.status, body: text.slice(0, 1000) } };

    let body: DelivrEventsResponse;
    try {
      body = JSON.parse(text) as DelivrEventsResponse;
    } catch {
      return { status: 'error', error: 'delivr: response was not JSON', cost_cents: DELIVR_MAX_COST_CENTS_PER_CALL, raw: { body: text.slice(0, 1000) } };
    }
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (rows.length === 0) {
      this.mismatches = 0;
      return { status: 'no_match', raw: { rows: 0, meta: body.meta ?? null } };
    }

    const matching = rows.filter((r) => rowMatchesVisit(r, input));
    if (matching.length === 0) {
      this.mismatches++;
      // Rows came back and we are billed for them, but none belong to this visit. Say so loudly.
      return {
        status: 'no_match',
        cost_cents: DELIVR_COST_CENTS * rows.length,
        raw: { rows: rows.length, unmatched: true, sample_ips: rows.map((r) => r.ip ?? null), meta: body.meta ?? null },
      };
    }
    this.mismatches = 0;
    // The live schema can send true/false flags as text, so read `resolved` with bool().
    const row =
      matching.find((r) => bool(r.resolved) === true && (r.first_name || r.last_name)) ?? matching.find((r) => bool(r.resolved) === true);
    if (!row) {
      return { status: 'no_match', cost_cents: DELIVR_COST_CENTS * rows.length, raw: { rows: rows.length, resolved: 0, meta: body.meta ?? null } };
    }
    const { lead, confidence } = mapDelivrRow(row);
    return {
      status: 'resolved',
      lead,
      confidence,
      cost_cents: DELIVR_COST_CENTS * rows.length,
      raw: { row, rows: rows.length, meta: body.meta ?? null },
      emails: allEmails(row),
      phones: allPhones(row),
    };
  }
}
