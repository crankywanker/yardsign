/**
 * Everything a search engine or an AI search tool reads about the site:
 * the public page list (one source of truth), robots.txt, sitemap.xml, llms.txt,
 * security.txt, canonical URLs, and which paths are private.
 *
 * `public-pages.json` holds the pages. It is JSON, not TypeScript, so the deploy
 * workflow can read it with plain Node and ping IndexNow about pages whose
 * `updated` date changed (scripts/indexnow-ping.mjs). Bump a page's `updated`
 * date when its content changes. Never use the deploy time: a lastmod that moves
 * on every deploy teaches Google to ignore it.
 */
import pagesJson from './public-pages.json';
import { LEARN_PAGES, type LearnPage } from './learn';

/** The canonical origin. Always https and the bare domain; www serves the same Worker. */
export const SITE_ORIGIN = 'https://tryyardsign.com';

export interface PublicPage {
  /** Path on the site, starting with "/". */
  path: string;
  title: string;
  /** One plain sentence. Shown in llms.txt. */
  description: string;
  /** YYYY-MM-DD. The day the page's content last changed. */
  updated: string;
}

const STATIC_PAGES: PublicPage[] = pagesJson;

/** Every page a crawler should find: the static pages plus live /learn articles. Drafts never appear. */
export function publicPages(learn: LearnPage[] = LEARN_PAGES): PublicPage[] {
  const live = learn.filter((p) => p.status === 'live').map(({ status: _status, ...rest }) => rest);
  return [...STATIC_PAGES, ...live];
}

/**
 * Paths that are never for search engines: the dashboard, the operator page, the JSON API,
 * the collector, the pixel script, Stripe, the after-checkout page (token in the URL), and
 * machine endpoints. Used for robots.txt and for the X-Robots-Tag header.
 */
export const PRIVATE_PREFIXES = ['/app', '/admin', '/api/', '/collect', '/p/', '/checkout', '/stripe/', '/welcome', '/demo.json', '/health'] as const;

/** True when `path` is one of the private routes or sits under one. */
export function isPrivatePath(path: string): boolean {
  return PRIVATE_PREFIXES.some((p) => path === p || path.startsWith(p.endsWith('/') ? p : `${p}/`));
}

/**
 * Paths whose 404 stays JSON even for a browser: the collector, the pixel, Stripe, the JSON
 * feed, and the bearer-token admin API. Everything else gets the HTML 404 page when the
 * request accepts HTML.
 */
const API_PREFIXES = ['/collect', '/p/', '/stripe/', '/demo.json', '/health', '/app/leads.json', '/api/'];

export function isApiPath(path: string): boolean {
  return API_PREFIXES.some((p) => path === p || path.startsWith(p.endsWith('/') ? p : `${p}/`));
}

/** True when the Accept header asks for HTML (a browser or a crawler fetching a page). */
export function wantsHtml(accept: string | undefined | null): boolean {
  return /\btext\/html\b/i.test(accept ?? '');
}

export function canonicalUrl(path: string): string {
  return `${SITE_ORIGIN}${path}`;
}

// ---------- robots.txt ----------

/** Search engines and AI search tools. They fetch pages to answer a question or show a result. */
export const SEARCH_CRAWLERS = ['Googlebot', 'Bingbot', 'OAI-SearchBot', 'ChatGPT-User', 'PerplexityBot', 'Perplexity-User', 'Claude-SearchBot', 'Claude-User', 'Applebot'];
/** Model-training crawlers. Allowed on purpose: the public pages are marketing, and we want models to know Yardsign. */
export const TRAINING_CRAWLERS = ['GPTBot', 'ClaudeBot', 'Google-Extended', 'CCBot'];

export const CONTENT_SIGNAL = 'Content-Signal: search=yes, ai-input=yes, ai-train=yes';

function robotsGroup(agents: string[]): string {
  return [...agents.map((a) => `User-agent: ${a}`), 'Allow: /', ...PRIVATE_PREFIXES.map((p) => `Disallow: ${p}`), CONTENT_SIGNAL].join('\n');
}

export function robotsTxt(): string {
  return [
    '# Yardsign (tryyardsign.com). Public pages are open to search engines and AI search tools.',
    '# Private routes (dashboard, operator page, API, collector, pixel, checkout) are closed.',
    '',
    robotsGroup(['*']),
    '',
    '# Search and AI search crawlers',
    robotsGroup(SEARCH_CRAWLERS),
    '',
    '# Model-training crawlers',
    robotsGroup(TRAINING_CRAWLERS),
    '',
    `Sitemap: ${SITE_ORIGIN}/sitemap.xml`,
    '',
  ].join('\n');
}

// ---------- sitemap.xml ----------

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function sitemapXml(pages: PublicPage[] = publicPages()): string {
  const urls = pages.map((p) => `  <url>\n    <loc>${escapeXml(canonicalUrl(p.path))}</loc>\n    <lastmod>${escapeXml(p.updated)}</lastmod>\n  </url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

// ---------- llms.txt ----------

export const SITE_SUMMARY = 'Yardsign tells home-service companies, like roofers, which households visited their website so they can follow up.';

export function llmsTxt(pages: PublicPage[] = publicPages()): string {
  const lines = pages.map((p) => `- [${p.title}](${canonicalUrl(p.path)}): ${p.description}`);
  return `# Yardsign\n\n${SITE_SUMMARY}\n\n## Pages\n\n${lines.join('\n')}\n`;
}

// ---------- security.txt ----------

/** The owner fills the contact. Bump the expiry once a year (RFC 9116 wants it under a year out). */
export const SECURITY_CONTACT = 'mailto:[SECURITY EMAIL]';
export const SECURITY_EXPIRES = '2027-10-06T00:00:00.000Z';

export function securityTxt(): string {
  return [`Contact: ${SECURITY_CONTACT}`, `Expires: ${SECURITY_EXPIRES}`, 'Preferred-Languages: en', `Canonical: ${SITE_ORIGIN}/.well-known/security.txt`, ''].join('\n');
}

// ---------- IndexNow ----------

/** IndexNow keys are 8 to 128 characters: letters, digits and dashes. */
export const INDEXNOW_KEY_RE = /^[A-Za-z0-9-]{8,128}$/;
