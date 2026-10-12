/**
 * The pixel payload. Short keys keep the beacon small. Everything is checked here
 * before it touches the database. Nothing typed by the visitor is accepted.
 */
import type { ScreenInfo } from '@yardsign/db';

export const MAX_PAYLOAD_BYTES = 8 * 1024;

export interface ViewPayload {
  e: 'view';
  k: string; // site key
  id: string; // visit id (UUID chosen by the pixel)
  vid: string; // visitor id (_ys_vid)
  sid: string; // session id (_ys_sid)
  u: string; // page URL
  r: string; // referrer
  t: string; // document title
  s: ScreenInfo;
  tz: string;
  l: string; // language
  ts: number; // browser clock, ms
}

export interface UnloadPayload {
  e: 'unload';
  k: string;
  id: string;
  vid: string;
  sid: string;
  top: number; // time on page, ms
  ts: number;
}

export type CollectPayload = ViewPayload | UnloadPayload;

export type ValidationResult = { ok: true; payload: CollectPayload } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SITE_KEY = /^[A-Za-z0-9_-]{4,64}$/;
const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function isValidSiteKey(k: unknown): k is string {
  return typeof k === 'string' && SITE_KEY.test(k);
}

function str(v: unknown, max: number): string | null {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') return null;
  return v.length > max ? v.slice(0, max) : v;
}

function num(v: unknown, min: number, max: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.min(max, Math.max(min, Math.round(v)));
}

function screen(v: unknown): ScreenInfo | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const w = num(o.w, 0, 20000);
  const h = num(o.h, 0, 20000);
  const vw = num(o.vw, 0, 20000);
  const vh = num(o.vh, 0, 20000);
  const dprRaw = typeof o.dpr === 'number' && Number.isFinite(o.dpr) ? o.dpr : 1;
  if (w === null || h === null || vw === null || vh === null) return null;
  return { w, h, vw, vh, dpr: Math.min(10, Math.max(0.1, Math.round(dprRaw * 100) / 100)) };
}

export function validatePayload(raw: unknown): ValidationResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'payload must be an object' };
  const o = raw as Record<string, unknown>;

  if (!isValidSiteKey(o.k)) return { ok: false, error: 'bad site key' };
  if (typeof o.id !== 'string' || !UUID.test(o.id)) return { ok: false, error: 'bad visit id' };
  if (typeof o.vid !== 'string' || !UUID.test(o.vid)) return { ok: false, error: 'bad visitor id' };
  if (typeof o.sid !== 'string' || !SESSION_ID.test(o.sid)) return { ok: false, error: 'bad session id' };
  const ts = num(o.ts, 0, 4102444800000); // up to year 2100
  if (ts === null) return { ok: false, error: 'bad timestamp' };

  if (o.e === 'unload') {
    const top = num(o.top, 0, 7 * 24 * 60 * 60 * 1000);
    if (top === null) return { ok: false, error: 'bad time on page' };
    return { ok: true, payload: { e: 'unload', k: o.k, id: o.id.toLowerCase(), vid: o.vid.toLowerCase(), sid: o.sid, top, ts } };
  }
  if (o.e !== 'view') return { ok: false, error: 'bad event type' };

  const u = str(o.u, 2048);
  if (!u) return { ok: false, error: 'missing url' };
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return { ok: false, error: 'bad url' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, error: 'bad url scheme' };

  const r = str(o.r, 2048);
  const t = str(o.t, 512);
  const tz = str(o.tz, 64);
  const l = str(o.l, 32);
  const s = screen(o.s);
  if (r === null || t === null || tz === null || l === null) return { ok: false, error: 'bad string field' };
  if (s === null) return { ok: false, error: 'bad screen' };

  return { ok: true, payload: { e: 'view', k: o.k, id: o.id.toLowerCase(), vid: o.vid.toLowerCase(), sid: o.sid, u, r, t, s, tz, l, ts } };
}

/** How far the browser clock may be from ours. It sets the Delivr search window and "pages viewed". */
export const MAX_CLOCK_SKEW_MS = 10 * 60 * 1000;

/** The browser's time, or ours when the browser clock is more than MAX_CLOCK_SKEW_MS off. */
export function clampClock(ts: number, now: number): number {
  return Math.abs(ts - now) > MAX_CLOCK_SKEW_MS ? now : ts;
}

/** Query keys kept on a stored page URL: campaign and ad-click tags. Anything else can hold form answers, emails or login tokens. */
const KEEP_QUERY_KEY = /^(utm_.*|gclid|gbraid|wbraid|fbclid|msclkid|ttclid|li_fat_id)$/i;

/** The page URL as stored: no #fragment, and only the allow-listed query keys, each kept exactly as sent. */
export function cleanPageUrl(u: string): string {
  const url = new URL(u);
  const kept = url.search.slice(1).split('&').filter((part) => KEEP_QUERY_KEY.test(part.split('=')[0] ?? ''));
  url.search = kept.length ? `?${kept.join('&')}` : '';
  url.hash = '';
  return url.href;
}

/** The referrer as stored: scheme, host and path. No query, fragment, user name or password. Empty when it does not parse. */
export function cleanReferrer(r: string): string {
  if (!r) return '';
  try {
    const url = new URL(r);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '';
  }
}

/** Parse the beacon body. The pixel sends text/plain to avoid a CORS preflight, so we never trust the content type. */
export function parseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
