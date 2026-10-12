/**
 * Cloudflare Access JWT check for the operator pages (/admin). Access sits in front of the
 * route and adds a `Cf-Access-Jwt-Assertion` header; we verify that token ourselves so a
 * request that somehow reaches the Worker without going through Access is still refused.
 * Fail closed: no config, no header, bad signature, wrong team, wrong audience or expired
 * all mean "no". We never trust the `Cf-Access-Authenticated-User-Email` header on its own.
 *
 * Keys come from https://<team>.cloudflareaccess.com/cdn-cgi/access/certs and are cached
 * in memory for a few minutes. A token signed with a key we have not seen refreshes the cache once,
 * and at most once a minute per team, so a stream of junk tokens cannot make every request fetch keys.
 */

export const ACCESS_JWT_HEADER = 'Cf-Access-Jwt-Assertion';
export const JWKS_TTL_MS = 10 * 60 * 1000;
/** At most one forced key refresh (for an unknown kid) per issuer in this long. */
export const FORCED_REFRESH_GAP_MS = 60 * 1000;
/** Clock skew we tolerate on exp / nbf, in seconds. */
export const CLOCK_SKEW_S = 60;

export interface AccessConfig {
  teamDomain: string | undefined;
  aud: string | undefined;
}

export interface AccessIdentity {
  /** The user's email as Access reports it in the token. Not logged anywhere. */
  email: string | null;
  sub: string | null;
}

export type AccessVerdict = { ok: true; identity: AccessIdentity } | { ok: false; reason: string };

interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

interface JwksCacheEntry {
  keys: Jwk[];
  fetchedAt: number;
  /** When an unknown kid last forced a refresh. */
  forcedAt?: number;
}

export interface VerifyOptions {
  fetchFn?: typeof fetch;
  now?: () => number;
  /** Shared across calls by default. Tests pass their own. */
  cache?: Map<string, JwksCacheEntry>;
}

const sharedCache = new Map<string, JwksCacheEntry>();

/** "yardsign", "yardsign.cloudflareaccess.com" or "https://yardsign.cloudflareaccess.com/" all become the issuer URL. */
export function accessIssuer(teamDomain: string): string | null {
  let t = teamDomain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!t) return null;
  if (!t.includes('.')) t = `${t}.cloudflareaccess.com`;
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(t)) return null;
  return `https://${t}`;
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(new TextDecoder().decode(b64urlToBytes(part))) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function loadKeys(issuer: string, opts: Required<Pick<VerifyOptions, 'fetchFn' | 'now' | 'cache'>>, force: boolean): Promise<Jwk[]> {
  const hit = opts.cache.get(issuer);
  if (hit && !force && opts.now() - hit.fetchedAt < JWKS_TTL_MS) return hit.keys;
  if (hit && force && hit.forcedAt !== undefined && opts.now() - hit.forcedAt < FORCED_REFRESH_GAP_MS) return hit.keys;
  const res = await opts.fetchFn(`${issuer}/cdn-cgi/access/certs`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`certs endpoint returned ${res.status}`);
  const body = (await res.json()) as { keys?: unknown };
  const keys = Array.isArray(body.keys) ? (body.keys as Jwk[]).filter((k) => k && typeof k === 'object') : [];
  opts.cache.set(issuer, { keys, fetchedAt: opts.now(), forcedAt: force ? opts.now() : hit?.forcedAt });
  return keys;
}

/** Verify a Cloudflare Access JWT. Never throws. */
export async function verifyAccessJwt(token: string | null | undefined, cfg: AccessConfig, options: VerifyOptions = {}): Promise<AccessVerdict> {
  const opts = { fetchFn: options.fetchFn ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init)), now: options.now ?? (() => Date.now()), cache: options.cache ?? sharedCache };
  const issuer = cfg.teamDomain ? accessIssuer(cfg.teamDomain) : null;
  const aud = (cfg.aud ?? '').trim();
  if (!issuer || !aud) return { ok: false, reason: 'access not configured' };
  if (!token) return { ok: false, reason: 'no token' };

  const parts = token.trim().split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return { ok: false, reason: 'malformed token' };
  const [h, p, sig] = parts as [string, string, string];
  const header = decodeJson(h);
  const payload = decodeJson(p);
  if (!header || !payload) return { ok: false, reason: 'malformed token' };
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) return { ok: false, reason: 'unsupported token' };

  if (payload.iss !== issuer) return { ok: false, reason: 'wrong issuer' };
  const audList = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audList.some((a) => typeof a === 'string' && a === aud)) return { ok: false, reason: 'wrong audience' };
  const nowS = Math.floor(opts.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_S <= nowS) return { ok: false, reason: 'expired' };
  if (typeof payload.nbf === 'number' && payload.nbf - CLOCK_SKEW_S > nowS) return { ok: false, reason: 'not yet valid' };

  let key: Jwk | undefined;
  try {
    key = (await loadKeys(issuer, opts, false)).find((k) => k.kid === header.kid);
    if (!key) key = (await loadKeys(issuer, opts, true)).find((k) => k.kid === header.kid);
  } catch (err) {
    return { ok: false, reason: `could not load signing keys: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!key || key.kty !== 'RSA' || !key.n || !key.e) return { ok: false, reason: 'unknown signing key' };

  try {
    const cryptoKey = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: key.n, e: key.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, b64urlToBytes(sig), new TextEncoder().encode(`${h}.${p}`));
    if (!valid) return { ok: false, reason: 'bad signature' };
  } catch {
    return { ok: false, reason: 'bad signature' };
  }

  return { ok: true, identity: { email: typeof payload.email === 'string' ? payload.email : null, sub: typeof payload.sub === 'string' ? payload.sub : null } };
}
