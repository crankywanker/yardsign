/** CORS for /collect: only the site's registered domains (and their subdomains) may post. */

export function hostnameAllowed(hostname: string, allowedDomains: string[]): boolean {
  const h = hostname.toLowerCase();
  return allowedDomains.some((d) => {
    const dom = d.toLowerCase().replace(/^\*\./, '');
    return h === dom || h.endsWith(`.${dom}`);
  });
}

/** Returns the origin to echo in Access-Control-Allow-Origin, or null when it is not allowed. */
export function allowedOrigin(originHeader: string | null, allowedDomains: string[]): string | null {
  if (!originHeader) return null;
  let url: URL;
  try {
    url = new URL(originHeader);
  } catch {
    return null;
  }
  return hostnameAllowed(url.hostname, allowedDomains) ? url.origin : null;
}

/**
 * The /collect origin check. Returns the CORS headers to send, or null to refuse. A page with
 * Referrer-Policy no-referrer or same-origin makes the browser send `Origin: null` on a no-cors
 * beacon, so then the page URL in the payload is checked instead, and no CORS headers go back
 * (a no-cors response is never read). Origin is a soft check either way: curl can send anything.
 */
export function collectCors(originHeader: string | null, pageUrl: string, allowedDomains: string[]): Record<string, string> | null {
  if (originHeader === 'null') return allowedOrigin(pageUrl, allowedDomains) ? {} : null;
  const origin = allowedOrigin(originHeader, allowedDomains);
  return origin ? corsHeaders(origin) : null;
}

export function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}
