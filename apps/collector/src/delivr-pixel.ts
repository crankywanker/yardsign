/**
 * One Delivr pixel per Yardsign site, made the moment the site is created, so a customer
 * who pays through Stripe resolves real people with no manual step. See docs/DELIVR.md.
 *
 * Best effort: a Delivr outage never blocks site creation. A site with no pixel id stays on
 * the mock provider; `PUT /api/admin/sites/:key/delivr` can add one later.
 */
import { listSitesMissingDelivrPixel, setSiteDelivrPixel, type Site } from '@yardsign/db';
import { errorFields, type Logger } from './log';

export const DELIVR_API = 'https://api.delivr.ai';

export interface DelivrPixelEnv {
  DB: D1Database;
  DELIVR_API_KEY?: string;
  DELIVR_API_SECRET?: string;
  /** The Delivr project to put pixels in. Public id, set in wrangler.toml. Looked up via whoami when empty. */
  DELIVR_PROJECT_ID?: string;
}

export function delivrConfigured(env: Pick<DelivrPixelEnv, 'DELIVR_API_KEY' | 'DELIVR_API_SECRET'>): boolean {
  return Boolean(env.DELIVR_API_KEY && env.DELIVR_API_SECRET);
}

function headers(env: DelivrPixelEnv): Record<string, string> {
  return { 'X-Api-Key': env.DELIVR_API_KEY ?? '', 'X-Api-Secret': env.DELIVR_API_SECRET ?? '', 'Content-Type': 'application/json', Accept: 'application/json' };
}

async function readJson<T>(res: Response, what: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) throw new Error(`delivr ${what}: ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`delivr ${what}: response was not JSON`);
  }
}

/** The project id: from env, else the first project the key can see. */
export async function delivrProjectId(env: DelivrPixelEnv, fetchFn: typeof fetch = (i, o) => fetch(i, o)): Promise<string> {
  const fromEnv = (env.DELIVR_PROJECT_ID ?? '').trim();
  if (fromEnv) return fromEnv;
  const res = await fetchFn(`${DELIVR_API}/api/v1/whoami`, { headers: headers(env), signal: AbortSignal.timeout(10_000) });
  const body = await readJson<{ response?: { projects?: Array<{ project_id?: string }> } }>(res, 'whoami');
  const id = body.response?.projects?.[0]?.project_id;
  if (!id) throw new Error('delivr whoami: no project on this key');
  return id;
}

export interface CreatedPixel {
  pixelId: string;
  installationUrl: string | null;
}

/** POST /api/v1/pixel/create. Not metered: a pixel is just an id. */
export async function createDelivrPixel(env: DelivrPixelEnv, title: string, fetchFn: typeof fetch = (i, o) => fetch(i, o)): Promise<CreatedPixel> {
  if (!delivrConfigured(env)) throw new Error('delivr: DELIVR_API_KEY and DELIVR_API_SECRET are required');
  const projectId = await delivrProjectId(env, fetchFn);
  const res = await fetchFn(`${DELIVR_API}/api/v1/pixel/create`, {
    method: 'POST',
    headers: headers(env),
    body: JSON.stringify({ project_id: projectId, title: title.slice(0, 120) }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await readJson<{ response?: { pixel_id?: string; installation_url?: string } }>(res, 'pixel/create');
  const pixelId = body.response?.pixel_id;
  if (!pixelId || !/^[A-Za-z0-9-]{8,64}$/.test(pixelId)) throw new Error('delivr pixel/create: no pixel_id in response');
  return { pixelId, installationUrl: body.response?.installation_url ?? null };
}

/**
 * Give the site a Delivr pixel if it has none and Delivr is configured. Stores the id on the
 * site row. Returns the id, or null when there is none (not configured, or Delivr failed; the
 * failure is logged). Never throws.
 */
export async function ensureDelivrPixel(env: DelivrPixelEnv, site: Site, log: Logger, fetchFn?: typeof fetch): Promise<string | null> {
  if (site.delivrPixelId) return site.delivrPixelId;
  if (!delivrConfigured(env)) return null;
  try {
    const { pixelId, installationUrl } = await createDelivrPixel(env, `Yardsign: ${site.name} (${site.siteKey})`, fetchFn);
    await setSiteDelivrPixel(env.DB, site.id, pixelId);
    log.info('delivr: pixel created for site', { site_id: site.id, site_key: site.siteKey, pixel_id: pixelId, installation_url: installationUrl });
    return pixelId;
  } catch (err) {
    log.warn('delivr: could not create a pixel for the site; it stays on the mock provider', { site_id: site.id, site_key: site.siteKey, ...errorFields(err) });
    return null;
  }
}

/**
 * A paying site (made through Stripe) whose pixel could not be made at checkout gets fake mock
 * leads until it has one. The hourly cron calls this, so each such site is retried at most once
 * an hour. Only with IDENTITY_PROVIDER = "delivr". Returns how many pixels it made. Never throws
 * for one site; a site that still has none is logged at error level so someone looks.
 */
export async function retryMissingDelivrPixels(env: DelivrPixelEnv & { IDENTITY_PROVIDER?: string }, log: Logger, fetchFn?: typeof fetch, limit = 10): Promise<number> {
  if ((env.IDENTITY_PROVIDER ?? 'mock').toLowerCase() !== 'delivr' || !delivrConfigured(env)) return 0;
  let made = 0;
  for (const site of await listSitesMissingDelivrPixel(env.DB, limit)) {
    if (await ensureDelivrPixel(env, site, log, fetchFn)) made++;
    else log.error('delivr: a paying site still has no Delivr pixel; its visits get mock leads', { site_id: site.id, site_key: site.siteKey });
  }
  return made;
}
