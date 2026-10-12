import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { BRAND_SENTENCE, FOOTER_LINKS, liveFooterLinks, siteFooter, TRUST_STRIP } from '../src/pages/footer';
import { publicPages } from '../src/seo';
import { PLANO_CF, SITE_ID } from './helpers';

async function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return await app.fetch(new Request(`http://localhost${path}`, { headers: { accept: 'text/html', ...headers }, cf: PLANO_CF } as unknown as RequestInit), env);
}

/** The hrefs inside <nav aria-label="Footer"> plus the bottom row, in order. */
function footerHrefs(html: string): string[] {
  const start = html.indexOf('<footer class="site');
  const end = html.indexOf('</footer>', start);
  expect(start, 'site footer present').toBeGreaterThan(-1);
  return [...html.slice(start, end).matchAll(/href="([^"]+)"/g)].map((m) => m[1] ?? '');
}

const PUBLIC = publicPages().map((p) => p.path);

describe('the site footer', () => {
  it('appears on every public page and on the HTML 404', async () => {
    for (const path of [...PUBLIC, '/nope']) {
      const html = await (await get(path)).text();
      expect(html, path).toContain('<footer class="site');
      expect(html, path).toContain('<nav aria-label="Footer"');
      expect(html, path).toContain(BRAND_SENTENCE);
      expect(html, path).toContain('© 2026 Yardsign · Built in Texas');
      const footer = html.slice(html.indexOf('<footer class="site'), html.indexOf('</footer>'));
      expect(footer, path).not.toContain('data broker'); // no registration number yet, so no line that claims one
      expect(footer, path).not.toMatch(/\[[^\]]+\]/); // no bracket placeholders in the footer
      expect(html, path).toContain('href="/sitemap.xml"');
      expect(html, path).toContain('href="/llms.txt"');
    }
  });

  it('never appears in the dashboard, the operator page or the after-checkout page', async () => {
    const privatePages = ['/app', '/app?key=dk_0000000000000000000000', `/app?key=test-admin-token&site=${SITE_ID}`, '/app/install?key=test-admin-token', '/admin', '/welcome'];
    for (const path of privatePages) {
      const html = await (await get(path)).text();
      expect(html, path).not.toContain('<footer class="site');
      expect(html, path).not.toContain('aria-label="Footer"');
    }
  });

  it('renders every live link and no link that is switched off', async () => {
    const html = await (await get('/privacy')).text();
    const hrefs = footerHrefs(html);
    for (const l of liveFooterLinks()) expect(hrefs, l.label).toContain(l.href);
    for (const l of FOOTER_LINKS.filter((x) => !x.live)) expect(hrefs, l.label).not.toContain(l.href);
    expect(html).not.toContain('href="/learn'); // the switched-off column leaves no trace
    expect(TRUST_STRIP.live).toBe(true); // on since the Texas-only rule (Oct 7)
    expect(html).toContain(TRUST_STRIP.text);
  });

  it('only links to pages that exist: every link returns 200 or is an anchor on the home page', async () => {
    const home = await (await get('/')).text();
    for (const href of footerHrefs(home)) {
      if (href.startsWith('/#')) {
        expect(home, href).toContain(`id="${href.slice(2)}"`);
        continue;
      }
      expect(href.startsWith('/'), href).toBe(true);
      const res = await get(href);
      expect(res.status, href).toBe(200);
    }
  });

  it('drops a column with nothing live and keeps plain-text columns', () => {
    const html = String(siteFooter('Yardsign'));
    for (const col of ['Product', 'Send leads to', 'Trust']) expect(html).toContain(`<h2>${col}</h2>`);
    for (const col of ['Install on', 'Learn', 'Free tools', 'Compare']) expect(html).not.toContain(`<h2>${col}</h2>`);
    expect(html).toContain('Email · GoHighLevel · Slack · Zapier · Webhook');
    expect(html).toContain('Works on WordPress, Wix, Squarespace and any site');

    const grown = String(siteFooter('Yardsign', FOOTER_LINKS.map((l) => ({ ...l, live: true }))));
    for (const col of ['Install on', 'Learn', 'Free tools', 'Compare']) expect(grown).toContain(`<h2>${col}</h2>`);
    expect(grown).toContain('href="/learn/who-visited-my-roofing-website"');
    expect(grown).not.toContain('Email · GoHighLevel'); // the stand-in text leaves once the column has real links
    const bare = String(siteFooter('Yardsign', []));
    expect(bare.match(/<h2>/g)?.length).toBe(1); // only the plain-text "Send leads to" column survives
    expect(bare).toContain('<h2>Send leads to</h2>');
  });

  it('uses real headings and real links with no doxxing codename anywhere', async () => {
    const html = await (await get('/')).text();
    const footer = html.slice(html.indexOf('<footer class="site'));
    expect(footer.match(/<h2>/g)?.length).toBeGreaterThanOrEqual(3);
    expect(footer).toMatch(/<a href="\/#how">How it works<\/a>/);
    expect(footer).toMatch(/<a href="\/app">Log in<\/a>/);
    expect(footer).not.toMatch(/codename/i);
  });

  it('keeps the company bracket off the footer while the legal pages still carry it', async () => {
    const privacy = await (await get('/privacy')).text();
    expect(privacy).toContain('[Company legal name], a Texas [LLC]');
    expect(privacy).not.toContain('[Company legal name] d/b/a');
  });
});
