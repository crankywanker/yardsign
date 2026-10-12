import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import { app } from '../src/app';

export const SITE_KEY = 'TESTKEY';
export const SITE_ID = 'site_test';
export const ORIGIN = 'http://localhost:3000';
export const HUMAN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

/** Deterministic UUID-shaped id. `suffix` sets the last two hex chars (e.g. "ff" for the mock error path). */
export function uuidFrom(n: number, suffix = '00'): string {
  const hex = n.toString(16).padStart(8, '0');
  return `${hex}-0000-4000-8000-0000000000${suffix}`;
}

export interface CfOverrides {
  country?: string;
  regionCode?: string;
  city?: string;
  postalCode?: string;
  latitude?: string;
  longitude?: string;
  asn?: number;
  asOrganization?: string;
  colo?: string;
  timezone?: string;
  botManagement?: { score?: number; verifiedBot?: boolean };
}

export const PLANO_CF: CfOverrides = {
  country: 'US',
  regionCode: 'TX',
  city: 'Plano',
  postalCode: '75024',
  latitude: '33.0198',
  longitude: '-96.6989',
  asn: 7018,
  asOrganization: 'AT&T Internet Services',
  colo: 'DFW',
};

export function viewPayload(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    k: SITE_KEY,
    e: 'view',
    id: crypto.randomUUID(),
    vid: uuidFrom(1),
    sid: 'abcdefgh12345678',
    u: 'http://localhost:3000/roof-repair?utm=x',
    r: 'https://www.google.com/',
    t: 'Roof repair in Plano',
    s: { w: 1920, h: 1080, vw: 1600, vh: 900, dpr: 1 },
    tz: 'America/Chicago',
    l: 'en-US',
    ts: Date.now(),
    ...over,
  };
}

/** Collects waitUntil promises so tests can await background work. */
export class TestExecutionContext {
  readonly promises: Promise<unknown>[] = [];
  readonly props: unknown = {};
  readonly exports = {} as Cloudflare.Exports;
  waitUntil(p: Promise<unknown>): void {
    this.promises.push(p);
  }
  passThroughOnException(): void {}
  async restore(): Promise<unknown> {
    return undefined;
  }
  async settle(): Promise<void> {
    await Promise.allSettled(this.promises);
  }
}

export interface CollectOptions {
  cf?: CfOverrides;
  origin?: string | null;
  ua?: string | null;
  ip?: string;
  rawBody?: string;
  envOverride?: Partial<Env>;
  contentLength?: string;
  gpc?: boolean;
}

/** POST a beacon straight into the Hono app with a fake request.cf. Returns the response and the context to settle. */
export async function postCollect(payload: Record<string, unknown> | null, opts: CollectOptions = {}): Promise<{ res: Response; ctx: TestExecutionContext }> {
  const headers = new Headers({ 'content-type': 'text/plain' });
  if (opts.origin !== null) headers.set('origin', opts.origin ?? ORIGIN);
  if (opts.ua !== null) headers.set('user-agent', opts.ua ?? HUMAN_UA);
  headers.set('cf-connecting-ip', opts.ip ?? '203.0.113.10');
  if (opts.contentLength) headers.set('content-length', opts.contentLength);
  if (opts.gpc) headers.set('sec-gpc', '1');
  const body = opts.rawBody ?? JSON.stringify(payload);
  const cf = (opts.cf ?? PLANO_CF) as unknown as RequestInitCfProperties;
  const req = new Request('http://localhost:8787/collect', { method: 'POST', headers, body, cf });
  const ctx = new TestExecutionContext();
  const res = await app.fetch(req, { ...env, ...opts.envOverride }, ctx as unknown as ExecutionContext);
  return { res, ctx };
}

/** A request for the pixel file as a real browser in Plano, Texas would send it. Override cf, UA or headers per test. */
export function pixelRequest(siteKey: string, opts: { cf?: CfOverrides | null; ua?: string; headers?: Record<string, string> } = {}): Request {
  const headers = new Headers({ 'user-agent': opts.ua ?? HUMAN_UA, 'cf-connecting-ip': '203.0.113.10', ...opts.headers });
  const init: RequestInit & { cf?: unknown } = { headers };
  if (opts.cf !== null) init.cf = (opts.cf ?? PLANO_CF) as unknown as RequestInitCfProperties;
  return new Request(`http://localhost:8787/p/${siteKey}.js`, init);
}

export function adminHeaders(): HeadersInit {
  return { authorization: 'Bearer test-admin-token' };
}
