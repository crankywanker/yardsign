import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { isPrivatePath, llmsTxt, PRIVATE_PREFIXES, publicPages, robotsTxt, SEARCH_CRAWLERS, sitemapXml, TRAINING_CRAWLERS } from '../src/seo';
import { PLANO_CF } from './helpers';

const PUBLIC = publicPages().map((p) => p.path);
const PRIVATE = ['/app', '/app/leads.json', '/app/install', '/app/delivery', '/admin', '/api/admin/sites', '/api/admin/visits', '/collect', '/p/TRYYARDSIGN.js', '/checkout', '/stripe/webhook', '/welcome', '/demo.json', '/health'];

async function get(path: string, headers: Record<string, string> = {}, init: RequestInit = {}): Promise<Response> {
  return await app.fetch(new Request(`http://localhost${path}`, { headers, cf: PLANO_CF, ...init } as RequestInit), env);
}

describe('the public page list', () => {
  it('has the four public pages with a date each', () => {
    expect(PUBLIC).toEqual(['/', '/privacy', '/terms', '/optout']);
    for (const p of publicPages()) expect(p.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('adds live /learn pages and never drafts', () => {
    const learn = [
      { path: '/learn/live', title: 'Live', description: 'x', updated: '2026-10-06', status: 'live' as const },
      { path: '/learn/draft', title: 'Draft', description: 'y', updated: '2026-10-06', status: 'draft' as const },
    ];
    const paths = publicPages(learn).map((p) => p.path);
    expect(paths).toContain('/learn/live');
    expect(paths).not.toContain('/learn/draft');
    expect(sitemapXml(publicPages(learn))).toContain('/learn/live');
    expect(sitemapXml(publicPages(learn))).not.toContain('draft');
    expect(llmsTxt(publicPages(learn))).not.toContain('draft');
  });

  it('knows which paths are private', () => {
    for (const p of PRIVATE) expect(isPrivatePath(p), p).toBe(true);
    for (const p of [...PUBLIC, '/style.css', '/robots.txt', '/sitemap.xml', '/llms.txt', '/apple', '/nope']) expect(isPrivatePath(p), p).toBe(false);
  });
});

describe('robots.txt', () => {
  it('is plain text with a Sitemap line, named crawlers and the content signal', async () => {
    const res = await get('/robots.txt');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const body = await res.text();
    expect(body).toContain('Sitemap: https://tryyardsign.com/sitemap.xml');
    expect(body).toContain('User-agent: *\nAllow: /');
    expect(body).toContain('Content-Signal: search=yes, ai-input=yes, ai-train=yes');
    for (const bot of [...SEARCH_CRAWLERS, ...TRAINING_CRAWLERS]) expect(body).toContain(`User-agent: ${bot}`);
    expect(res.headers.get('x-robots-tag')).toBeNull();
  });

  it('never disallows a public page and disallows every private prefix', () => {
    const disallowed = robotsTxt()
      .split('\n')
      .filter((l) => l.startsWith('Disallow:'))
      .map((l) => l.slice('Disallow:'.length).trim());
    for (const p of PUBLIC) expect(disallowed.some((d) => p === d || p.startsWith(d)), p).toBe(false);
    for (const p of PRIVATE_PREFIXES) expect(disallowed).toContain(p);
    expect(disallowed).not.toContain('/style.css');
  });
});

describe('sitemap.xml and llms.txt', () => {
  it('serves the sitemap as XML with every public page and no private route', async () => {
    const res = await get('/sitemap.xml');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/xml');
    const body = await res.text();
    expect(body).toContain('<?xml version="1.0"');
    for (const p of publicPages()) {
      expect(body).toContain(`<loc>https://tryyardsign.com${p.path}</loc>`);
      expect(body).toContain(`<lastmod>${p.updated}</lastmod>`);
    }
    for (const p of PRIVATE) expect(body).not.toContain(`<loc>https://tryyardsign.com${p}</loc>`);
    expect(body).not.toMatch(/<loc>http:/);
    for (const loc of body.match(/<loc>[^<]*<\/loc>/g) ?? []) expect(loc).not.toContain('?'); // clean URLs, no query strings
  });

  it('serves llms.txt as plain text with the heading, one sentence, and every public page', async () => {
    const res = await get('/llms.txt');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const body = await res.text();
    expect(body.startsWith('# Yardsign\n')).toBe(true);
    for (const p of publicPages()) expect(body).toContain(`](https://tryyardsign.com${p.path}): ${p.description}`);
    for (const p of PRIVATE) expect(body).not.toContain(`https://tryyardsign.com${p}`);
  });
});

describe('security.txt and the IndexNow key file', () => {
  it('serves security.txt with a contact and an expiry', async () => {
    const res = await get('/.well-known/security.txt');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const body = await res.text();
    expect(body).toContain('Contact: mailto:');
    expect(body).toMatch(/Expires: 20\d\d-\d\d-\d\dT/);
  });

  it('serves the IndexNow key only at /<key>.txt and only when the key is set', async () => {
    const key = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
    const withKey = (path: string) => app.fetch(new Request(`http://localhost${path}`), { ...env, INDEXNOW_KEY: key });
    const ok = await withKey(`/${key}.txt`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toContain('text/plain');
    expect(await ok.text()).toBe(key);
    expect((await withKey('/ffffffffffffffffffffffffffffffff.txt')).status).toBe(404);
    expect((await get(`/${key}.txt`)).status).toBe(404); // INDEXNOW_KEY unset in tests
    expect((await get('/robots.txt')).status).toBe(200); // the key route never shadows the fixed files
  });
});

describe('index rules', () => {
  it('sends X-Robots-Tag: noindex on every private route', async () => {
    const checks: Array<[string, RequestInit]> = [
      ['/app', {}],
      ['/app/leads.json', {}],
      ['/app/install', {}],
      ['/admin', {}],
      ['/api/admin/sites', {}],
      ['/welcome', {}],
      ['/demo.json', {}],
      ['/health', {}],
      ['/p/TRYYARDSIGN.js', {}],
      ['/p/NOPE.js', {}],
      ['/checkout', { method: 'POST', body: new URLSearchParams({ email: 'x' }) }],
      ['/collect', { method: 'POST', body: 'nope' }],
    ];
    for (const [path, init] of checks) {
      const res = await get(path, { accept: 'text/html' }, init);
      expect(res.headers.get('x-robots-tag'), `${path} (${res.status})`).toBe('noindex, nofollow');
    }
  });

  it('never sends it on a public page, and every public page has a canonical link', async () => {
    for (const p of publicPages()) {
      const res = await get(p.path, { accept: 'text/html' });
      expect(res.status, p.path).toBe(200);
      expect(res.headers.get('x-robots-tag'), p.path).toBeNull();
      const html = await res.text();
      expect(html, p.path).toContain(`<link rel="canonical" href="https://tryyardsign.com${p.path}">`);
      expect(html, p.path).not.toContain('name="robots" content="noindex"');
    }
    for (const p of ['/style.css', '/robots.txt', '/sitemap.xml', '/llms.txt']) expect((await get(p)).headers.get('x-robots-tag'), p).toBeNull();
  });

  it('links the stylesheet with a version so a deploy is never stuck behind the cache', async () => {
    const html = await (await get('/privacy', { accept: 'text/html' })).text();
    const m = html.match(/href="\/style\.css\?v=([a-z0-9]+)"/);
    expect(m).not.toBeNull();
    expect((await get(`/style.css?v=${m?.[1]}`)).status).toBe(200);
  });

  it('keeps the canonical clean when the request carries a query string or www', async () => {
    const res = await app.fetch(new Request('http://www.tryyardsign.com/privacy?utm_source=x', { headers: { accept: 'text/html' } }), env);
    expect(await res.text()).toContain('<link rel="canonical" href="https://tryyardsign.com/privacy">');
  });
});

describe('404s', () => {
  it('gives a browser an HTML 404 page with a link home', async () => {
    const res = await get('/nope', { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    const html = await res.text();
    expect(html).toContain('Page not found');
    expect(html).toContain('href="/"');
    expect(html).toContain('name="robots" content="noindex"');
  });

  it('keeps JSON 404s for API callers and for API paths', async () => {
    const api = await get('/nope', { accept: 'application/json' });
    expect(api.status).toBe(404);
    expect(api.headers.get('content-type')).toContain('application/json');
    expect(await api.json()).toEqual({ error: 'not found' });
    const noAccept = await get('/nope');
    expect(noAccept.headers.get('content-type')).toContain('application/json');
    const collector = await get('/collect/extra', { accept: 'text/html' });
    expect(collector.status).toBe(404);
    expect(collector.headers.get('content-type')).toContain('application/json');
    const adminApi = await get('/api/admin/sites/x/y/z', { accept: 'text/html', authorization: 'Bearer test-admin-token' });
    expect(adminApi.status).toBe(404);
    expect(adminApi.headers.get('content-type')).toContain('application/json');
  });
});

describe('the codename', () => {
  it('is in no public output', async () => {
    const outputs = [robotsTxt(), sitemapXml(), llmsTxt()];
    for (const p of [...PUBLIC, '/nope', '/.well-known/security.txt']) outputs.push(await (await get(p, { accept: 'text/html' })).text());
    for (const out of outputs) expect(out).not.toMatch(/codename/i);
  });
});
