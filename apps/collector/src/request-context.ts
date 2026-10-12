/**
 * What Cloudflare tells us about a request for free. Read once per request, with
 * every field optional, because `request.cf` is partly or fully empty under
 * `wrangler dev` and in tests.
 */
export interface RequestContext {
  ip: string;
  country: string | null;
  region: string | null;
  city: string | null;
  postal: string | null;
  asn: number | null;
  asOrganization: string | null;
  colo: string | null;
  lat: number | null;
  lng: number | null;
  /** IANA time zone of the connection, like "America/Chicago". */
  timezone: string | null;
  botScore: number | null;
  verifiedBot: boolean;
  userAgent: string | null;
  /** The browser sent Sec-GPC: 1 (Global Privacy Control). */
  gpc: boolean;
  /** True when request.cf was empty: wrangler dev or a test without cf. */
  local: boolean;
}

type CfLike = Partial<IncomingRequestCfProperties> & { botManagement?: { score?: number; verifiedBot?: boolean } };

function numOrNull(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function readRequestContext(req: Request): RequestContext {
  const cf = ((req as Request & { cf?: CfLike }).cf ?? {}) as CfLike;
  const ip = req.headers.get('cf-connecting-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '0.0.0.0';
  return {
    ip,
    country: strOrNull(cf.country),
    region: strOrNull(cf.regionCode) ?? strOrNull(cf.region),
    city: strOrNull(cf.city),
    postal: strOrNull(cf.postalCode),
    asn: numOrNull(cf.asn),
    asOrganization: strOrNull(cf.asOrganization),
    colo: strOrNull(cf.colo),
    lat: numOrNull(cf.latitude),
    lng: numOrNull(cf.longitude),
    timezone: strOrNull(cf.timezone),
    botScore: numOrNull(cf.botManagement?.score),
    verifiedBot: cf.botManagement?.verifiedBot === true,
    userAgent: req.headers.get('user-agent'),
    gpc: req.headers.get('sec-gpc') === '1',
    local: cf.country === undefined && cf.asn === undefined,
  };
}
