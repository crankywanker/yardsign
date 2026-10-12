import { describe, expect, it } from 'vitest';
import { DELIVR_COST_CENTS, DELIVR_MAX_COST_CENTS_PER_CALL, DELIVR_MISMATCH_TRIP, DELIVR_SELECT, DelivrProvider, allEmails, allPhones, delivrBool, delivrList, getProvider, mapDelivrRow, pickPhone, rowMatchesVisit, type DelivrEventRow, type ResolveInput } from '../src';

const PIXEL = '11111111-2222-3333-4444-555555555555';
const T0 = Date.UTC(2026, 9, 5, 20, 0, 0);

function input(over: Partial<ResolveInput> = {}): ResolveInput {
  return {
    visitor_id: '11111111-1111-4111-8111-111111111111',
    visit_id: 'v1',
    site_id: 'site_yardsign',
    ip: '203.0.113.5',
    ip_hash: 'abc',
    user_agent: 'Mozilla/5.0',
    geo: { country: 'US', region: 'TX', city: 'Plano', postal: '75024', lat: 33.0, lng: -96.7, asn: 7018 },
    occurred_at: T0,
    created_at: T0,
    provider_site_id: PIXEL,
    ...over,
  };
}

/** Shaped like a real resolution_full_profile row (field names from the live schema; values from the dev key's sample). */
function row(over: Partial<DelivrEventRow> = {}): DelivrEventRow {
  return {
    event_id: 'evt_0001',
    event_type: 'page_view',
    timestamp: T0 + 1000,
    ip: '203.0.113.5',
    client_ip: '203.0.113.5',
    cookie_id: 'ck_1',
    pixel_id: PIXEL,
    resolved: true,
    event_data: '{"url":"https://tryyardsign.com/","static_params":{"ys_vid":"11111111-1111-4111-8111-111111111111","ys_key":"TRYYARDSIGN"}}',
    first_name: 'Liam',
    middle_name: 'J',
    last_name: 'Patel',
    personal_address: '88 Maple Ct',
    personal_address_2: null,
    personal_city: 'Denver',
    personal_state: 'Colorado',
    personal_state_code: 'CO',
    personal_zip: '80202',
    personal_zip4: '1234',
    dpv_code: 'Y',
    mobile_phones: ['(303) 555-0101', '(303) 555-0102'],
    mobile_phones_dnc: ['(303) 555-0101'],
    personal_phones: ['(303) 555-0199'],
    personal_phones_dnc: [],
    phones: [],
    phones_dnc: [],
    personal_email: 'liam.patel@example.com',
    personal_emails: ['liam.patel@example.com'],
    email: 'liam.patel@globex.example',
    is_homeowner: true,
    is_married: true,
    has_children: false,
    age_range: '35-44',
    income_range_lc: '100k-150k',
    net_worth: '250k-500k',
    linkedin_url: 'https://www.linkedin.com/in/liampatel',
    ...over,
  };
}

function fakeFetch(handler: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>): { fetchFn: typeof fetch; calls: URL[] } {
  const calls: URL[] = [];
  const fetchFn = (async (u: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(u));
    calls.push(url);
    return handler(url, init);
  }) as typeof fetch;
  return { fetchFn, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Field names of the live resolution_full_profile schema, as the "Probe the Delivr account" workflow printed them on Oct 7. */
const LIVE_SCHEMA = new Set(
  `event_id event_model source event_source_id date pixel_id organization_id event_type timestamp ts_millis cookie_id hem hems user_agent client_ip ip
  event_data headers referrer_url extra_json resolved is_bot bot_type ip_country gpc address_id age_range business_emails company_address company_address2
  company_city company_country company_description company_domain company_employee_count company_employee_count_range company_id company_id_right
  company_industry company_linkedin_url company_naics company_name company_name_history company_phones company_phones_dnc company_related_domains
  company_revenue_range company_sic company_state company_total_revenue company_zip_code current_business_email current_business_email_validation_date
  current_business_email_validation_status department department_2 department_raw direct_numbers direct_numbers_dnc domain_lc dpv_code education_history
  email email_last_seen email_validation_status emails emails_md5_lc_hem emails_md5_uc_hem emails_sha1_lc_hem emails_sha1_uc_hem emails_sha256_lc_hem
  emails_sha256_uc_hem first_name first_uuid_norm flattened_uuids gender has_children headline income_range_lc inferred_gender inferred_gender_unisex
  inferred_years_experience invalid_emails is_email_business is_email_personal is_homeowner is_international is_married is_profile_b2b is_profile_b2c
  job_functions job_title job_title_history last_name last_updated linkedin_url md5_lc_hem md5_uc_hem middle_name mobile_phones mobile_phones_dnc
  mobile_phones_validation_date mobile_phones_validation_status net_worth personal_address personal_address_2 personal_city personal_country
  personal_country_alpha2 personal_country_alpha3 personal_country_numeric personal_email personal_email_validation_status personal_emails personal_phones
  personal_phones_dnc personal_state personal_state_code personal_timezone personal_zip personal_zip4 phones phones_dnc photo_url primary_contact_emails
  profile_pid_all seniority_level seniority_level_2 seniority_level_raw sha1_lc_hem sha1_uc_hem sha256_lc_hem sha256_uc_hem social_connections
  subdepartments valid_emails twitter_url github_url facebook_url job_title_normalized`.split(/\s+/),
);

describe('DELIVR_SELECT', () => {
  it('names only fields that exist in the live schema (one unknown name fails the whole query with a 400)', () => {
    const unknown = DELIVR_SELECT.split(',').filter((f: string) => !LIVE_SCHEMA.has(f));
    expect(unknown).toEqual([]);
  });
});

describe('text-typed fields from the live schema', () => {
  it('reads lists as arrays, JSON text, or comma-separated text', () => {
    expect(delivrList(['a', ' b ', ''])).toEqual(['a', 'b']);
    expect(delivrList('["(303) 555-0101","(303) 555-0102"]')).toEqual(['(303) 555-0101', '(303) 555-0102']);
    expect(delivrList('(303) 555-0101, (303) 555-0102;x@example.com')).toEqual(['(303) 555-0101', '(303) 555-0102', 'x@example.com']);
    expect(delivrList('')).toEqual([]);
    expect(delivrList(null)).toEqual([]);
    expect(delivrList(42)).toEqual([]);
  });

  it('reads flags as booleans or text, and unknown text as null', () => {
    expect(delivrBool(true)).toBe(true);
    expect(delivrBool('true')).toBe(true);
    expect(delivrBool('False')).toBe(false);
    expect(delivrBool('1')).toBe(true);
    expect(delivrBool('maybe')).toBeNull();
    expect(delivrBool(null)).toBeNull();
  });

  it('maps a row whose lists and flags arrived as text', () => {
    const r = row({ mobile_phones: '["(303) 555-0101","(303) 555-0102"]', mobile_phones_dnc: '(303) 555-0101', is_homeowner: 'true' });
    const { lead, confidence } = mapDelivrRow(r);
    expect(lead.phone).toBe('(303) 555-0102');
    expect((lead.extra as { is_homeowner: unknown }).is_homeowner).toBe(true);
    expect(confidence).toBe(0.9); // dpv Y, homeowner, phone
  });
});

describe('fields we never collect', () => {
  const NEVER = ['is_married', 'has_children', 'age_range', 'income_range_lc', 'net_worth'];

  it('does not ask Delivr for age, income, net worth, marital status or children', () => {
    const asked = DELIVR_SELECT.split(',');
    for (const f of NEVER) expect(asked).not.toContain(f);
  });

  it('drops them from the lead even if a row carries them', () => {
    const { lead } = mapDelivrRow(row());
    const extra = JSON.stringify(lead.extra);
    for (const f of [...NEVER, 'income_range']) expect(extra).not.toContain(f);
  });
});

describe('every email and phone, for the opt-out check', () => {
  it('lists personal and business emails once each, lowercased', () => {
    expect(allEmails(row({ personal_email: 'Liam@Example.com', personal_emails: '["liam@example.com","lp@home.example"]', email: 'liam@globex.example' }))).toEqual([
      'liam@example.com',
      'lp@home.example',
      'liam@globex.example',
    ]);
    expect(allEmails(row({ personal_email: null, personal_emails: null, email: null }))).toEqual([]);
  });

  it('lists every phone, do-not-call ones included', () => {
    expect(allPhones(row())).toEqual(['(303) 555-0101', '(303) 555-0102', '(303) 555-0199']);
  });
});

describe('mapDelivrRow', () => {
  it('maps the personal fields and skips do-not-call phones', () => {
    const { lead, confidence } = mapDelivrRow(row());
    expect(lead.first_name).toBe('Liam');
    expect(lead.last_name).toBe('Patel');
    expect(lead.address_line1).toBe('88 Maple Ct');
    expect(lead.address_line2).toBeUndefined();
    expect(lead.city).toBe('Denver');
    expect(lead.state).toBe('CO');
    expect(lead.zip).toBe('80202');
    expect(lead.phone).toBe('(303) 555-0102'); // first mobile not on the DNC list
    expect(lead.email).toBe('liam.patel@example.com'); // personal before business
    expect(lead.linkedin_url).toContain('linkedin.com');
    expect(lead.extra).toMatchObject({ provider: 'delivr', is_homeowner: true, dpv_code: 'Y', zip4: '1234', event_id: 'evt_0001' });
    expect(confidence).toBe(0.9);
  });

  it('falls back through phone lists and to the business email', () => {
    expect(pickPhone(row({ mobile_phones: [], personal_phones: [], phones: ['555'], phones_dnc: [] }))).toBe('555');
    expect(pickPhone(row({ mobile_phones: ['a'], mobile_phones_dnc: ['a'], personal_phones: [], phones: [] }))).toBeUndefined();
    const { lead, confidence } = mapDelivrRow(row({ personal_email: null, personal_emails: [], dpv_code: 'N', is_homeowner: false, mobile_phones: [], personal_phones: [], phones: [] }));
    expect(lead.email).toBe('liam.patel@globex.example');
    expect(lead.phone).toBeUndefined();
    expect(confidence).toBe(0.7);
  });

  it('scores thin matches lower: email only, then a name with no street address', () => {
    const empty = { first_name: null, last_name: null, personal_address: null, mobile_phones: [], personal_phones: [], phones: [], dpv_code: null, is_homeowner: null };
    expect(mapDelivrRow(row(empty)).confidence).toBe(0.3); // email only
    expect(mapDelivrRow(row({ ...empty, first_name: 'Liam' })).confidence).toBe(0.5); // name and email, no address
    // A dpv code means nothing without a street address.
    expect(mapDelivrRow(row({ ...empty, dpv_code: 'Y' })).confidence).toBe(0.3);
  });
});

describe('do-not-call lists', () => {
  const two = { mobile_phones: ['(303) 555-0101', '(303) 555-0102'], personal_phones: ['(303) 555-0199'], phones: [] };

  it('compares numbers by their digits, whatever the formatting', () => {
    expect(pickPhone(row({ ...two, mobile_phones_dnc: ['+1 303-555-0101'] }))).toBe('(303) 555-0102');
    expect(pickPhone(row({ ...two, mobile_phones_dnc: '3035550101' }))).toBe('(303) 555-0102');
    expect(pickPhone(row({ ...two, mobile_phones_dnc: '["303.555.0101","1 (303) 555-0102"]' }))).toBe('(303) 555-0199'); // both mobiles listed: next list
  });

  it('reads a list of flags that lines up with the phones', () => {
    expect(pickPhone(row({ ...two, mobile_phones_dnc: ['Y', 'N'] }))).toBe('(303) 555-0102');
    expect(pickPhone(row({ ...two, mobile_phones_dnc: 'true,false' }))).toBe('(303) 555-0102');
    expect(pickPhone(row({ ...two, mobile_phones_dnc: [true, false] as unknown as string[] }))).toBe('(303) 555-0102');
    expect(pickPhone(row({ ...two, mobile_phones_dnc: '[true,false]' }))).toBe('(303) 555-0102');
    expect(pickPhone(row({ ...two, mobile_phones_dnc: ['N', 'N'] }))).toBe('(303) 555-0101');
    expect(pickPhone(row({ ...two, mobile_phones_dnc: ['Y', 'Y'], personal_phones_dnc: ['Y'] }))).toBeUndefined();
  });

  it('treats every phone as callable when there is no list', () => {
    expect(pickPhone(row({ ...two, mobile_phones_dnc: null }))).toBe('(303) 555-0101');
    expect(pickPhone(row({ ...two, mobile_phones_dnc: [] }))).toBe('(303) 555-0101');
    expect(pickPhone(row({ ...two, mobile_phones_dnc: '' }))).toBe('(303) 555-0101');
  });
});

describe('rowMatchesVisit', () => {
  it('matches on ip, client_ip, or our visitor id inside event_data', () => {
    const inp = input();
    expect(rowMatchesVisit(row(), inp)).toBe(true);
    expect(rowMatchesVisit(row({ ip: 'x', client_ip: '203.0.113.5', event_data: '' }), inp)).toBe(true);
    expect(rowMatchesVisit(row({ ip: 'x', client_ip: 'y' }), inp)).toBe(true); // via ys_vid in event_data
    expect(rowMatchesVisit(row({ ip: 'x', client_ip: 'y', event_data: '{}' }), inp)).toBe(false);
    expect(rowMatchesVisit(row({ ip: 'test_ip_1', client_ip: null, event_data: 'test_event_data_1' }), inp)).toBe(false); // the dev key's sample row
  });
});

describe('DelivrProvider', () => {
  it('throws when not configured', async () => {
    const p = new DelivrProvider({ apiKey: undefined, apiSecret: 'x' });
    await expect(p.resolve(input())).rejects.toThrow(/not configured/);
  });

  it('errors for a site without a pixel, and no_match only when there is neither a visitor id nor an ip', async () => {
    const { fetchFn, calls } = fakeFetch(() => json({ rows: [] }));
    const p = new DelivrProvider({ apiKey: 'k', apiSecret: 's', fetchFn });
    expect((await p.resolve(input({ provider_site_id: null }))).status).toBe('error');
    expect((await p.resolve(input({ ip: null, visitor_id: 'not-a-uuid' }))).status).toBe('no_match');
    expect(calls).toHaveLength(0);
    // The visitor id alone is enough to ask: the raw ip is only a fallback join key now.
    expect((await p.resolve(input({ ip: null }))).status).toBe('no_match');
    expect(calls).toHaveLength(1);
    expect((calls[0] as URL).searchParams.get('filter')).toBe('event_data:like:11111111-1111-4111-8111-111111111111,resolved:eq:true');
  });

  it('builds a tight, cheap query: one pixel, short window, visitor-id filter, resolved only, small limit, key pair headers', async () => {
    let seen: RequestInit | undefined;
    const { fetchFn, calls } = fakeFetch((_u, init) => {
      seen = init;
      return json({ rows: [] });
    });
    const p = new DelivrProvider({ apiKey: 'dlvr_k', apiSecret: 's3', fetchFn, now: () => T0 + 60_000 });
    const r = await p.resolve(input());
    expect(r.status).toBe('no_match');
    expect(r.cost_cents).toBeUndefined(); // empty results are free
    const u = calls[0] as URL;
    expect(u.pathname).toBe('/api/v3/events/resolution_full_profile');
    expect(u.searchParams.get('pixel_id')).toBe(PIXEL);
    expect(u.searchParams.get('filter')).toBe('event_data:like:11111111-1111-4111-8111-111111111111,resolved:eq:true');
    // A malformed visitor id never goes into the filter string; the ip takes its place.
    await p.resolve(input({ visitor_id: 'x" OR 1=1' }));
    expect((calls[1] as URL).searchParams.get('filter')).toBe('ip:eq:203.0.113.5,resolved:eq:true');
    expect(u.searchParams.get('limit')).toBe('1'); // one billable row at most
    expect(p.maxCostCentsPerCall).toBe(2.5); // what the spend cap reserves before each call
    expect(Number(u.searchParams.get('start_ms'))).toBeLessThan(T0);
    expect(Number(u.searchParams.get('end_ms'))).toBe(T0 + 60_000); // never asks past "now"
    expect(u.searchParams.get('select')).toContain('personal_address');
    const headers = seen?.headers as Record<string, string>;
    expect(headers['X-Api-Key']).toBe('dlvr_k');
    expect(headers['X-Api-Secret']).toBe('s3');
  });

  it('builds the search window from our server clock, not the browser clock', async () => {
    const { fetchFn, calls } = fakeFetch(() => json({ rows: [] }));
    const p = new DelivrProvider({ apiKey: 'k', apiSecret: 's', fetchFn, now: () => T0 + 3 * 60 * 60_000 });
    await p.resolve(input({ occurred_at: T0 + 20 * 60_000, created_at: T0 })); // the phone's clock runs 20 minutes fast
    const u = calls[0] as URL;
    expect(Number(u.searchParams.get('start_ms'))).toBe(T0 - 15 * 60_000);
    expect(Number(u.searchParams.get('end_ms'))).toBe(T0 + 2 * 60 * 60_000);
  });

  it('counts the worst case when a 200 body cannot be read or parsed, since it may be billed', async () => {
    const broken = (status: number) => new Response(new ReadableStream({ start(c) { c.error(new Error('The operation timed out')); } }), { status });
    const cutOff = new DelivrProvider({ apiKey: 'k', apiSecret: 's', fetchFn: fakeFetch(() => broken(200)).fetchFn });
    const r = await cutOff.resolve(input());
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/timed out/);
    expect(r.cost_cents).toBe(DELIVR_MAX_COST_CENTS_PER_CALL);
    const garbled = new DelivrProvider({ apiKey: 'k', apiSecret: 's', fetchFn: fakeFetch(() => new Response('{"rows":[', { status: 200 })).fetchFn });
    expect((await garbled.resolve(input())).cost_cents).toBe(DELIVR_MAX_COST_CENTS_PER_CALL);
    // An error status is not billed, read or not.
    const failed = new DelivrProvider({ apiKey: 'k', apiSecret: 's', fetchFn: fakeFetch(() => broken(500)).fetchFn });
    const f = await failed.resolve(input());
    expect(f.status).toBe('error');
    expect(f.cost_cents).toBeUndefined();
  });

  it('turns a matching resolved row into a lead and bills per row returned', async () => {
    const { fetchFn } = fakeFetch(() => json({ rows: [row()], meta: { took_ms: 3 } }));
    const p = new DelivrProvider({ apiKey: 'k', apiSecret: 's', fetchFn });
    const r = await p.resolve(input());
    expect(r.status).toBe('resolved');
    expect(r.lead?.last_name).toBe('Patel');
    expect(r.lead?.address_line1).toBe('88 Maple Ct');
    expect(r.confidence).toBe(0.9);
    expect(r.cost_cents).toBe(DELIVR_COST_CENTS);
    expect((r.raw as { rows: number }).rows).toBe(1);
  });

  it('prefers a resolved row with a name, and ignores unresolved rows', async () => {
    const { fetchFn } = fakeFetch(() => json({ rows: [row({ resolved: false, first_name: 'Nope' }), row({ first_name: null, last_name: null, event_id: 'e2' }), row({ event_id: 'e3' })] }));
    const p = new DelivrProvider({ apiKey: 'k', apiSecret: 's', fetchFn });
    const r = await p.resolve(input());
    expect(r.status).toBe('resolved');
    expect((r.raw as { row: DelivrEventRow }).row.event_id).toBe('e3');
    expect(r.cost_cents).toBe(DELIVR_COST_CENTS * 3);
  });

  it('reads a resolved flag sent as text ("true"), the way the live schema types flags', async () => {
    const { fetchFn } = fakeFetch(() => json({ rows: [row({ resolved: 'true' as unknown as boolean, event_id: 'e9' })] }));
    const p = new DelivrProvider({ apiKey: 'k', apiSecret: 's', fetchFn });
    const r = await p.resolve(input());
    expect(r.status).toBe('resolved');
    expect((r.raw as { row: DelivrEventRow }).row.event_id).toBe('e9');
  });

  it('reports no_match with the cost when rows come back for someone else, and trips the breaker', async () => {
    const sample = { rows: [row({ ip: 'test_ip_1', client_ip: null, event_data: 'test_event_data_1' })] };
    const { fetchFn, calls } = fakeFetch(() => json(sample));
    const p = new DelivrProvider({ apiKey: 'k', apiSecret: 's', fetchFn });
    for (let i = 0; i < DELIVR_MISMATCH_TRIP; i++) {
      const r = await p.resolve(input({ visit_id: `v${i}` }));
      expect(r.status).toBe('no_match');
      expect(r.cost_cents).toBe(DELIVR_COST_CENTS);
      expect((r.raw as { unmatched: boolean }).unmatched).toBe(true);
    }
    const tripped = await p.resolve(input({ visit_id: 'v-last' }));
    expect(tripped.status).toBe('error');
    expect(tripped.error).toMatch(/protect the bill/);
    expect(calls).toHaveLength(DELIVR_MISMATCH_TRIP);
  });

  it('resets the breaker after an empty result', async () => {
    let n = 0;
    const { fetchFn } = fakeFetch(() => json(n++ < 2 ? { rows: [row({ ip: 'other', client_ip: 'other', event_data: '' })] } : { rows: [] }));
    const p = new DelivrProvider({ apiKey: 'k', apiSecret: 's', fetchFn });
    await p.resolve(input());
    await p.resolve(input());
    expect((await p.resolve(input())).status).toBe('no_match');
    expect((await p.resolve(input())).status).toBe('no_match'); // would have tripped without the reset
  });

  it('surfaces HTTP and network failures as errors, never throws', async () => {
    const bad = new DelivrProvider({ apiKey: 'k', apiSecret: 's', fetchFn: fakeFetch(() => new Response('{"code":"bad_filter"}', { status: 400, statusText: 'Bad Request' })).fetchFn });
    const r = await bad.resolve(input());
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/400/);
    const down = new DelivrProvider({ apiKey: 'k', apiSecret: 's', fetchFn: (async () => { throw new Error('ECONNRESET'); }) as typeof fetch });
    expect((await down.resolve(input())).error).toMatch(/ECONNRESET/);
    const html = new DelivrProvider({ apiKey: 'k', apiSecret: 's', fetchFn: fakeFetch(() => new Response('<html>', { status: 200 })).fetchFn });
    expect((await html.resolve(input())).error).toMatch(/not JSON/);
  });
});

describe('getProvider with a site', () => {
  it('uses Delivr only for sites that have a pixel; others stay on mock', () => {
    const env = { IDENTITY_PROVIDER: 'delivr', DELIVR_API_KEY: 'k', DELIVR_API_SECRET: 's' };
    expect(getProvider(env, { delivrPixelId: PIXEL }).name).toBe('delivr');
    expect(getProvider(env, { delivrPixelId: null }).name).toBe('mock');
    expect(getProvider(env).name).toBe('delivr');
    expect(getProvider({ IDENTITY_PROVIDER: 'mock' }, { delivrPixelId: PIXEL }).name).toBe('mock');
  });
});
