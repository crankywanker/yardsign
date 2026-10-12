/**
 * Webhook delivery. One generic JSON shape that GoHighLevel inbound webhooks,
 * Zapier, Make and n8n accept as-is, plus a Slack incoming-webhook shape and a
 * GoHighLevel contact-field shape. Ported from the old app's src/deliver.ts.
 */
import type { LeadRow, WebhookKind } from '@yardsign/db';
import type { DeliveryChannel, LeadPayload } from './delivery';
import { hailJson, hailLine, type HailFacts } from './email/hail';
import type { Logger } from './log';

export interface WebhookContext {
  siteName: string;
  pages: string[];
  mock: boolean;
  /** Hail near the home. Undefined sends `hail: null` (scoring did not run). */
  hail?: HailFacts;
  /** Clock for "9 days ago". Tests pin it. */
  now?: number;
}

export function webhookBody(kind: WebhookKind, lead: LeadPayload, ctx: WebhookContext): unknown {
  const name = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'Unknown';
  const address = [lead.address_line1, lead.address_line2].filter(Boolean).join(', ');
  const confidence = lead.confidence === null ? 'unknown' : `${Math.round(lead.confidence * 100)}%`;
  const now = ctx.now ?? Date.now();
  const hail = hailLine(ctx.hail, now);
  if (kind === 'slack') {
    return {
      text:
        (ctx.mock ? ':test_tube: *TEST LEAD (mock person)* — ' : '') +
        `:bell: *${name}* — ${address} ${lead.city ?? ''} ${lead.state ?? ''} ${lead.zip ?? ''}\n` +
        `:telephone_receiver: ${lead.phone ?? '—'}  :email: ${lead.email ?? '—'}\n` +
        (hail ? `:cloud_with_lightning: ${hail}\n` : '') +
        `Confidence: ${confidence}  •  Viewed: ${ctx.pages.join(', ') || '—'}  •  ${ctx.siteName}`,
    };
  }
  if (kind === 'ghl') {
    return {
      firstName: lead.first_name,
      lastName: lead.last_name,
      email: lead.email,
      phone: lead.phone,
      address1: address,
      city: lead.city,
      state: lead.state,
      postalCode: lead.zip,
      source: 'Yardsign',
      tags: ['yardsign', `confidence:${confidence}`, ...(ctx.hail?.kind === 'found' ? ['yardsign-hail'] : []), ...(ctx.mock ? ['yardsign-test'] : [])],
      customField: { pages_viewed: ctx.pages.join(', '), site: ctx.siteName, ...(hail ? { hail } : {}) },
    };
  }
  return { ...lead, test: ctx.mock, site_name: ctx.siteName, pages: ctx.pages, hail: hailJson(ctx.hail, now) };
}

export class WebhookChannel implements DeliveryChannel {
  readonly name: string;
  constructor(
    private readonly url: string,
    private readonly kind: WebhookKind,
    private readonly context: (lead: LeadRow) => Promise<WebhookContext>,
    private readonly fetchFn: typeof fetch = (input, init) => fetch(input, init),
  ) {
    this.name = `webhook:${kind}`;
  }

  async send(lead: LeadRow, payload: LeadPayload, log: Logger): Promise<void> {
    const ctx = await this.context(lead);
    const res = await this.fetchFn(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'Yardsign-Webhook/1.0' },
      body: JSON.stringify(webhookBody(this.kind, payload, ctx)),
      signal: AbortSignal.timeout(10_000),
    });
    const text = (await res.text()).slice(0, 300);
    if (!res.ok) throw new Error(`webhook ${res.status}: ${text}`);
    log.info('lead delivered (webhook channel)', { kind: this.kind, status: res.status, mock: ctx.mock });
  }
}

/** Our own domain. A webhook may never point at it or any name under it. */
const OWN_DOMAIN = 'tryyardsign.com';

/** Loopback, private, link-local, carrier-grade NAT and "this network" IPv4 ranges. `ip` is dotted decimal. */
function isPrivateIpv4(ip: string): boolean {
  const [a = -1, b = -1] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** `ip` is the inside of a bracketed IPv6 literal, as the URL parser writes it (lower case, shortest form). */
function isPrivateIpv6(ip: string): boolean {
  if (ip === '::' || ip === '::1') return true;
  if (/^f[cd][0-9a-f]{0,2}:/.test(ip)) return true; // unique local, fc00::/7
  if (/^fe[89ab][0-9a-f]?:/.test(ip)) return true; // link-local, fe80::/10
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip); // an IPv4 address inside IPv6
  if (mapped) {
    const hi = parseInt(mapped[1]!, 16);
    const lo = parseInt(mapped[2]!, 16);
    return isPrivateIpv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return false;
}

/** Only https URLs, never our own host or any Worker, never a private address. */
export function isAllowedWebhookUrl(raw: string, ownHost?: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const h = u.hostname.toLowerCase().replace(/\.$/, ''); // "localhost." is localhost
  if (!h) return false;
  if (ownHost && h === ownHost.toLowerCase().replace(/\.$/, '')) return false;
  if (h === OWN_DOMAIN || h.endsWith(`.${OWN_DOMAIN}`) || h === 'workers.dev' || h.endsWith('.workers.dev')) return false;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return false;
  if (h.startsWith('[')) return !isPrivateIpv6(h.slice(1, -1));
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return !isPrivateIpv4(h);
  return true;
}
