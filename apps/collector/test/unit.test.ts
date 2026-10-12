import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { BOT_SCORE_DROP_BELOW, isBot, isBotUserAgent } from '../src/bots';
import { allowedOrigin, collectCors, hostnameAllowed } from '../src/cors';
import { parseDevice } from '../src/device';
import { BLOCKED_COUNTRIES, isGeoBlocked } from '../src/geo-block';
import { hashIp, safeEqual } from '../src/hash';
import { checkRateLimit, ipv6Prefix64, pruneRateLimits } from '../src/rate-limit';
import { clampClock, cleanPageUrl, cleanReferrer, validatePayload } from '../src/validate';
import { HUMAN_UA, viewPayload } from './helpers';

describe('validatePayload', () => {
  it('accepts a good view beacon', () => {
    const r = validatePayload(viewPayload());
    expect(r.ok).toBe(true);
    if (r.ok && r.payload.e === 'view') {
      expect(r.payload.u).toContain('/roof-repair');
      expect(r.payload.s.w).toBe(1920);
    }
  });

  it('accepts a good unload beacon', () => {
    const r = validatePayload({ k: 'TESTKEY', e: 'unload', id: crypto.randomUUID(), vid: crypto.randomUUID(), sid: 'abcdefgh12345678', top: 12345.6, ts: Date.now() });
    expect(r.ok).toBe(true);
    if (r.ok && r.payload.e === 'unload') expect(r.payload.top).toBe(12346);
  });

  it.each([
    ['not an object', 'nope'],
    ['array', []],
    ['bad site key', viewPayload({ k: 'bad key!' })],
    ['bad visit id', viewPayload({ id: 'abc' })],
    ['bad visitor id', viewPayload({ vid: 123 })],
    ['bad session id', viewPayload({ sid: 'short' })],
    ['bad event', viewPayload({ e: 'form' })],
    ['missing url', viewPayload({ u: '' })],
    ['bad url scheme', viewPayload({ u: 'javascript:alert(1)' })],
    ['bad screen', viewPayload({ s: 'big' })],
    ['bad timestamp', viewPayload({ ts: 'now' })],
    ['title not a string', viewPayload({ t: { x: 1 } })],
  ])('rejects %s', (_label, raw) => {
    expect(validatePayload(raw).ok).toBe(false);
  });

  it('truncates long strings instead of failing', () => {
    const r = validatePayload(viewPayload({ t: 'x'.repeat(5000) }));
    expect(r.ok).toBe(true);
    if (r.ok && r.payload.e === 'view') expect(r.payload.t).toHaveLength(512);
  });
});

describe('geo block', () => {
  it('blocks EU, EEA, UK and Switzerland', () => {
    for (const c of ['DE', 'FR', 'IE', 'NL', 'IS', 'LI', 'NO', 'GB', 'CH', 'de']) expect(isGeoBlocked(c), c).toBe(true);
    expect(BLOCKED_COUNTRIES.size).toBe(32);
  });
  it('allows the US and everything else', () => {
    for (const c of ['US', 'CA', 'MX', 'AU', 'JP', 'BR']) expect(isGeoBlocked(c), c).toBe(false);
    expect(isGeoBlocked(null)).toBe(false);
    expect(isGeoBlocked(undefined)).toBe(false);
  });
});

describe('bot filter', () => {
  it('flags known bot user agents and empty ones', () => {
    for (const ua of ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'curl/8.4.0', 'python-requests/2.31', 'HeadlessChrome/120', '', 'x']) {
      expect(isBotUserAgent(ua), ua).toBe(true);
    }
  });
  it('passes a normal browser', () => {
    expect(isBotUserAgent(HUMAN_UA)).toBe(false);
    expect(isBot({ userAgent: HUMAN_UA, botScore: null, verifiedBot: false })).toBe(false);
    expect(isBot({ userAgent: HUMAN_UA, botScore: 85, verifiedBot: false })).toBe(false);
  });
  it('uses the Cloudflare bot score and verified-bot flag when present', () => {
    expect(isBot({ userAgent: HUMAN_UA, botScore: BOT_SCORE_DROP_BELOW - 1, verifiedBot: false })).toBe(true);
    expect(isBot({ userAgent: HUMAN_UA, botScore: BOT_SCORE_DROP_BELOW, verifiedBot: false })).toBe(false);
    expect(isBot({ userAgent: HUMAN_UA, botScore: null, verifiedBot: true })).toBe(true);
  });
});

describe('ip hashing', () => {
  it('is deterministic, salted and hex', async () => {
    const a = await hashIp('203.0.113.10', 'salt-a');
    const b = await hashIp('203.0.113.10', 'salt-a');
    const c = await hashIp('203.0.113.10', 'salt-b');
    const d = await hashIp('203.0.113.11', 'salt-a');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain('203.0.113');
  });
  it('refuses an empty salt', async () => {
    await expect(hashIp('1.2.3.4', '')).rejects.toThrow(/IP_SALT/);
  });
  it('safeEqual compares tokens', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'ab')).toBe(false);
  });
});

describe('cors', () => {
  const domains = ['example.com', 'localhost'];
  it('matches exact hosts and subdomains, with any port', () => {
    expect(hostnameAllowed('example.com', domains)).toBe(true);
    expect(hostnameAllowed('www.example.com', domains)).toBe(true);
    expect(hostnameAllowed('notexample.com', domains)).toBe(false);
    expect(hostnameAllowed('example.com.evil.net', domains)).toBe(false);
    expect(allowedOrigin('http://localhost:3000', domains)).toBe('http://localhost:3000');
    expect(allowedOrigin('https://www.example.com', domains)).toBe('https://www.example.com');
    expect(allowedOrigin('https://evil.net', domains)).toBeNull();
    expect(allowedOrigin(null, domains)).toBeNull();
    expect(allowedOrigin('garbage', domains)).toBeNull();
  });
  it('falls back to the page URL only for Origin: null, and sends no CORS headers then', () => {
    expect(collectCors('https://www.example.com', 'https://evil.net/', domains)?.['Access-Control-Allow-Origin']).toBe('https://www.example.com');
    expect(collectCors('null', 'https://www.example.com/roof?x=1', domains)).toEqual({});
    expect(collectCors('null', 'https://evil.net/roof', domains)).toBeNull();
    expect(collectCors('null', '', domains)).toBeNull();
    expect(collectCors(null, 'https://www.example.com/', domains)).toBeNull();
    expect(collectCors('https://evil.net', 'https://www.example.com/', domains)).toBeNull();
  });
});

describe('what collect stores', () => {
  it('keeps only campaign and ad-click tags on the page URL, and drops the fragment', () => {
    expect(cleanPageUrl('https://a.com/roof?utm_source=fb&email=pat%40x.com&UTM_Term=Roof+Repair&gclid=1&gbraid=2&wbraid=3&fbclid=4&msclkid=5&ttclid=6&li_fat_id=7&utm=x#t=1')).toBe(
      'https://a.com/roof?utm_source=fb&UTM_Term=Roof+Repair&gclid=1&gbraid=2&wbraid=3&fbclid=4&msclkid=5&ttclid=6&li_fat_id=7',
    );
    expect(cleanPageUrl('https://a.com/roof?name=Pat#x')).toBe('https://a.com/roof');
    expect(cleanPageUrl('https://a.com/?')).toBe('https://a.com/');
    expect(cleanPageUrl('http://a.com:8080/p')).toBe('http://a.com:8080/p');
  });
  it('keeps the origin and path of the referrer', () => {
    expect(cleanReferrer('https://u:p@www.google.com/search?q=pat#x')).toBe('https://www.google.com/search');
    expect(cleanReferrer('android-app://com.slack/')).toBe('android-app://com.slack/');
    expect(cleanReferrer('')).toBe('');
    expect(cleanReferrer('not a url')).toBe('');
  });
  it('uses our clock when the browser clock is more than 10 minutes off', () => {
    const now = 1_760_000_000_000;
    expect(clampClock(now - 9 * 60_000, now)).toBe(now - 9 * 60_000);
    expect(clampClock(now + 11 * 60_000, now)).toBe(now);
    expect(clampClock(0, now)).toBe(now);
  });
  it('lower-cases the ids on view and unload beacons alike', () => {
    const id = 'ABCDEF01-2345-4678-89AB-CDEF01234567';
    for (const raw of [viewPayload({ id, vid: id }), { k: 'TESTKEY', e: 'unload', id, vid: id, sid: 'abcdefgh12345678', top: 1, ts: 1 }]) {
      const r = validatePayload(raw);
      expect(r.ok && [r.payload.id, r.payload.vid]).toEqual([id.toLowerCase(), id.toLowerCase()]);
    }
  });
});

describe('device parsing', () => {
  it('reads type, browser and os', () => {
    expect(parseDevice(HUMAN_UA)).toEqual({ type: 'desktop', browser: 'Chrome', os: 'Windows' });
    expect(parseDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')).toEqual({ type: 'phone', browser: 'Safari', os: 'iOS' });
    expect(parseDevice(null).type).toBe('other');
  });
});

describe('rate limit (D1 sliding window)', () => {
  it('allows up to the limit then denies', async () => {
    const now = Date.UTC(2026, 9, 5, 12, 0, 1);
    const key = 'ip:test';
    for (let i = 1; i <= 3; i++) expect((await checkRateLimit(env.DB, key, 3, now)).allowed, `hit ${i}`).toBe(true);
    expect((await checkRateLimit(env.DB, key, 3, now)).allowed).toBe(false);
  });
  it('weights the previous minute by how much of the current minute is left', async () => {
    const key = 'site:test';
    const minuteStart = Date.UTC(2026, 9, 5, 12, 0, 0);
    for (let i = 0; i < 10; i++) await checkRateLimit(env.DB, key, 100, minuteStart - 1000); // 10 hits in the previous minute
    // 6 seconds into the next minute: 10 * 0.9 = 9 carried over, plus this one = 10
    const r = await checkRateLimit(env.DB, key, 100, minuteStart + 6000);
    expect(r.estimate).toBeCloseTo(10, 5);
    // 54 seconds in: 10 * 0.1 = 1 carried over, plus the two hits this minute = 3
    const r2 = await checkRateLimit(env.DB, key, 100, minuteStart + 54000);
    expect(r2.estimate).toBeCloseTo(3, 5);
  });
  it('groups IPv6 addresses by their /64 and leaves IPv4 alone', () => {
    expect(ipv6Prefix64('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(ipv6Prefix64('2001:0DB8:0001:0002::ffff')).toBe('2001:db8:1:2::/64');
    expect(ipv6Prefix64('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ipv6Prefix64('::1')).toBe('0:0:0:0::/64');
    expect(ipv6Prefix64('203.0.113.10')).toBeNull();
    expect(ipv6Prefix64('::ffff:203.0.113.10')).toBeNull();
  });
  it('prunes old buckets', async () => {
    const t = Date.UTC(2026, 9, 5, 12, 0, 0);
    await checkRateLimit(env.DB, 'k', 10, t - 10 * 60_000);
    await checkRateLimit(env.DB, 'k', 10, t);
    expect(await pruneRateLimits(env.DB, t)).toBe(1);
  });
});
