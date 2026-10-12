/**
 * Files for crawlers: robots.txt, sitemap.xml, llms.txt, security.txt and the IndexNow key file.
 * All built from the one public page list in src/seo.ts.
 */
import { Hono } from 'hono';
import type { Env } from '../env';
import { INDEXNOW_KEY_RE, llmsTxt, robotsTxt, securityTxt, sitemapXml } from '../seo';

export const seoRoutes = new Hono<{ Bindings: Env }>();

const CACHE = 'public, max-age=3600';

seoRoutes.get('/robots.txt', (c) => {
  c.header('Content-Type', 'text/plain; charset=utf-8');
  c.header('Cache-Control', CACHE);
  return c.body(robotsTxt());
});

seoRoutes.get('/sitemap.xml', (c) => {
  c.header('Content-Type', 'application/xml; charset=utf-8');
  c.header('Cache-Control', CACHE);
  return c.body(sitemapXml());
});

seoRoutes.get('/llms.txt', (c) => {
  c.header('Content-Type', 'text/plain; charset=utf-8');
  c.header('Cache-Control', CACHE);
  return c.body(llmsTxt());
});

seoRoutes.get('/.well-known/security.txt', (c) => {
  c.header('Content-Type', 'text/plain; charset=utf-8');
  c.header('Cache-Control', CACHE);
  return c.body(securityTxt());
});

/**
 * The IndexNow key file: GET /<key>.txt returns the key. The key is public by design;
 * it lives in the INDEXNOW_KEY secret so rotating it is one GitHub change.
 */
seoRoutes.get('/:file{[A-Za-z0-9-]{8,128}\\.txt}', (c) => {
  const key = (c.env.INDEXNOW_KEY ?? '').trim();
  const file = c.req.param('file');
  if (!INDEXNOW_KEY_RE.test(key) || file !== `${key}.txt`) return c.notFound();
  c.header('Content-Type', 'text/plain; charset=utf-8');
  c.header('Cache-Control', CACHE);
  return c.body(key);
});
