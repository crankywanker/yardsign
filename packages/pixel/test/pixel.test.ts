import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { ENDPOINT_TOKEN, PIXEL_SIZE_BYTES, PIXEL_SOURCE, SITE_KEY_TOKEN, installSnippet, renderPixel } from '../dist/index.js';

describe('pixel build', () => {
  it('stays under 4 KB minified', () => {
    expect(PIXEL_SIZE_BYTES).toBeLessThanOrEqual(4096);
    expect(Buffer.byteLength(PIXEL_SOURCE, 'utf8')).toBe(PIXEL_SIZE_BYTES);
  });

  it('carries both tokens and the kill switch', () => {
    expect(PIXEL_SOURCE).toContain(SITE_KEY_TOKEN);
    expect(PIXEL_SOURCE).toContain(ENDPOINT_TOKEN);
    expect(PIXEL_SOURCE).toContain('yardsign');
    expect(PIXEL_SOURCE).toContain('disabled');
  });

  it('never reads form fields or keystrokes', () => {
    const src = readFileSync(join(__dirname, '../src/pixel.ts'), 'utf8');
    for (const banned of ['.value', 'keydown', 'keypress', 'keyup', 'input', 'FormData', 'elements']) {
      expect(src, `source must not reference ${banned}`).not.toContain(banned);
    }
  });

  it('renders a site key and endpoint and rejects unsafe ones', () => {
    const js = renderPixel('TESTKEY', 'http://localhost:8787/collect');
    expect(js).toContain('"TESTKEY"');
    expect(js).toContain('"http://localhost:8787/collect"');
    expect(js).not.toContain(SITE_KEY_TOKEN);
    expect(() => renderPixel('bad key"', 'http://x')).toThrow();
    expect(() => renderPixel('TESTKEY', 'javascript:alert(1)')).toThrow();
  });

  it('bails out for automated browsers and headless screens before any beacon', () => {
    const src = readFileSync(join(__dirname, '../src/pixel.ts'), 'utf8');
    const bail = src.indexOf('webdriver');
    expect(bail).toBeGreaterThan(0);
    expect(bail).toBeLessThan(src.indexOf('function send('));
    expect(src).toContain('!screen.width || !screen.height');
    expect(PIXEL_SOURCE).toContain('webdriver');
  });

  it('loads the partner script right after the page view, once, and never for automated browsers', () => {
    const src = readFileSync(join(__dirname, '../src/pixel.ts'), 'utf8');
    expect(src).toContain('partnerDone');
    const tail = src.slice(src.lastIndexOf('view();'));
    expect(tail).toContain('partner();');
    // The webdriver and empty-screen bail-out runs before the partner script can load.
    expect(src.indexOf('webdriver')).toBeLessThan(src.indexOf('function partner('));
    expect(PIXEL_SOURCE).toContain('sitelytics');
  });

  it('builds the install snippet', () => {
    expect(installSnippet('TESTKEY')).toBe('<script async src="https://cdn.tryyardsign.com/p/TESTKEY.js"></script>');
  });
});

interface Sent {
  via: 'fetch' | 'beacon';
  url: string;
  body: Record<string, unknown>;
  init?: Record<string, unknown>;
}

/** Run the built pixel in a fake browser and record what it stores and sends. */
async function runPixel(opts: { disabled?: boolean; cookie?: string; noFetch?: boolean; fetchThrows?: boolean; partnerId?: string } = {}) {
  const cookies: string[] = [];
  const local = new Map<string, string>();
  const sent: Sent[] = [];
  const beacons: Promise<void>[] = [];
  const scripts: unknown[] = [];
  const win: Record<string, unknown> = { innerWidth: 1600, innerHeight: 900, devicePixelRatio: 1, addEventListener() {} };
  if (opts.disabled) win.yardsign = { disabled: true };
  const sandbox: Record<string, unknown> = {
    window: win,
    screen: { width: 1920, height: 1080 },
    location: { href: 'https://roofer.example/roof', protocol: 'https:' },
    history: { pushState() {} },
    document: {
      get cookie() {
        return opts.cookie ?? '';
      },
      set cookie(v: string) {
        cookies.push(v);
      },
      referrer: '',
      title: 'Roofs',
      visibilityState: 'visible',
      addEventListener() {},
      querySelector: () => null,
      createElement: () => ({ setAttribute() {} }),
      head: { appendChild: (s: unknown) => scripts.push(s) },
    },
    navigator: {
      language: 'en-US',
      sendBeacon(url: string, blob: Blob) {
        beacons.push(blob.text().then((text) => void sent.push({ via: 'beacon', url, body: JSON.parse(text) })));
        return true;
      },
    },
    localStorage: { getItem: (k: string) => local.get(k) ?? null, setItem: (k: string, v: string) => void local.set(k, v) },
    crypto: { randomUUID: () => crypto.randomUUID() },
    Blob,
    setTimeout,
  };
  if (!opts.noFetch) {
    sandbox.fetch = (url: string, init: Record<string, unknown>) => {
      if (opts.fetchThrows) throw new TypeError('fetch blocked');
      sent.push({ via: 'fetch', url, body: JSON.parse(String(init.body)), init });
      return Promise.resolve();
    };
  }
  runInNewContext(renderPixel('TESTKEY', 'https://collect.example/collect', opts.partnerId ?? ''), sandbox);
  await Promise.all(beacons);
  return { cookies, local, sent, scripts };
}

describe('pixel in a browser', () => {
  it('posts with fetch in cors mode, so the real Origin is always sent', async () => {
    const { sent } = await runPixel();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.via).toBe('fetch');
    expect(sent[0]?.url).toBe('https://collect.example/collect');
    expect(sent[0]?.init).toMatchObject({ method: 'POST', mode: 'cors', credentials: 'omit', keepalive: true, headers: { 'content-type': 'text/plain' } });
    expect(sent[0]?.body).toMatchObject({ k: 'TESTKEY', e: 'view', u: 'https://roofer.example/roof' });
  });

  it('falls back to sendBeacon when there is no fetch, or it throws', async () => {
    expect((await runPixel({ noFetch: true })).sent.map((s) => s.via)).toEqual(['beacon']);
    expect((await runPixel({ fetchThrows: true })).sent.map((s) => s.via)).toEqual(['beacon']);
  });

  it('the kill switch stops it before it touches any storage', async () => {
    const { cookies, local, sent, scripts } = await runPixel({ disabled: true, partnerId: 'abc-123' });
    expect(cookies).toEqual([]);
    expect(local.size).toBe(0);
    expect(sent).toEqual([]);
    expect(scripts).toEqual([]);
  });

  it('keeps a valid stored visitor id in lower case and replaces one the server would refuse', async () => {
    const id = 'ABCDEF01-2345-4678-89AB-CDEF01234567';
    const kept = await runPixel({ cookie: `_ys_vid=${id}` });
    expect(kept.sent[0]?.body.vid).toBe(id.toLowerCase());
    expect(kept.cookies.some((c) => c.startsWith(`_ys_vid=${id.toLowerCase()};`))).toBe(true);
    expect(kept.local.get('_ys_vid')).toBe(id.toLowerCase());

    const bad = '------------------------------------'; // 36 characters, not a UUID
    const replaced = await runPixel({ cookie: `_ys_vid=${bad}` });
    const vid = String(replaced.sent[0]?.body.vid);
    expect(vid).not.toBe(bad);
    expect(vid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
