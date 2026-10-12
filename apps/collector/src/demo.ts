/**
 * The free signals: ASN class and the public demo card. Ported from the old app's
 * sighting.ts. Nothing here is person-level; it powers the landing page and the
 * data-center cost filter. The rules themselves live in src/policy.ts.
 */
import type { AsnClass } from '@yardsign/db';
import { parseDevice } from './device';
import { ALLOWED_STATES, identityGate, stateCode, type IdentityGateReason } from './policy';
import type { RequestContext } from './request-context';

/** Coarse ASN classification. Good enough to decide "try" vs "skip". Replace with IPinfo/Spur data when there is budget. */
export function classifyAsn(asn: number | null, org: string | null): AsnClass {
  const o = (org ?? '').toLowerCase();
  if (!o && asn === null) return 'unknown';
  if (o.includes('icloud') || o.includes('private relay')) return 'relay';
  if (/\b(amazon|aws|google cloud|google llc|gcp|microsoft|azure|digitalocean|linode|akamai|ovh|hetzner|vultr|oracle|cloudflare|fastly|m247|datacamp|choopa|leaseweb|contabo|hostinger|godaddy|rackspace|ionos)\b/.test(o)) return 'hosting';
  if (/\b(nordvpn|expressvpn|mullvad|proton|surfshark|private internet access|cyberghost|ipvanish|windscribe|vpn)\b/.test(o)) return 'relay';
  if (/\b(t-mobile|verizon wireless|cellco|at&t mobility|sprint|us cellular|cricket|metro ?pcs|boost|dish wireless)\b/.test(o)) return 'mobile';
  if (/\b(comcast|xfinity|charter|spectrum|cox|at&t|frontier|centurylink|lumen|windstream|optimum|altice|mediacom|verizon fios|google fiber|starlink|wideopenwest|wow|suddenlink|astound|rcn|tds|consolidated|brightspeed|ziply|sparklight|cable one|midco|gci|hughesnet|viasat)\b/.test(o)) return 'residential';
  return 'business';
}

/** The fields the public demo card shows. Never anything person-level. */
export interface DemoView {
  local: boolean;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
  isp: string | null;
  network: string;
  asnClass: AsnClass;
  device: string;
  browser: string;
  timezone: string | null;
  localTime: string | null;
}

const NETWORK_LABEL: Record<AsnClass, string> = {
  residential: 'Home internet',
  mobile: 'Cell data',
  business: 'Business / small ISP',
  hosting: 'Data center',
  relay: 'VPN or Private Relay',
  unknown: 'Unknown',
};

export function demoView(ctx: RequestContext, timezone: string | null): DemoView {
  const asnClass = classifyAsn(ctx.asn, ctx.asOrganization);
  const device = parseDevice(ctx.userAgent);
  let localTime: string | null = null;
  if (timezone) {
    try {
      localTime = new Date().toLocaleTimeString('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' });
    } catch {
      localTime = null;
    }
  }
  return {
    local: ctx.local,
    city: ctx.city,
    state: ctx.region,
    zip: ctx.postal,
    country: ctx.country,
    isp: ctx.asOrganization,
    network: NETWORK_LABEL[asnClass],
    asnClass,
    device: device.type,
    browser: device.browser,
    timezone,
    localTime,
  };
}

export interface Verdict {
  wouldTry: boolean;
  why: string;
  /** Short machine reason, the same one the policy stores as visits.skip_reason. */
  reason: string | null;
}

export interface GateInput {
  local: boolean;
  gpc: boolean;
  country: string | null;
  region: string | null;
  asnClass: AsnClass;
  /** The request looks like a bot (user agent, bot score). Optional: the stored visit was already filtered. */
  bot?: boolean;
}

const WHY: Record<IdentityGateReason, (g: GateInput) => string> = {
  bot_or_datacenter: () => 'This looks like a data center or a bot, not a person. We do not spend a lookup on it.',
  gpc: () => 'Your browser sent a Global Privacy Control signal. We honor it: our identity partner never loads for you.',
  non_us: (g) => `You appear to be outside the US${g.country ? ` (${g.country})` : ''}. We only work in the US.`,
  region_unknown: () => "We can't tell which state you are in, so we would not try.",
  not_allowed_state: (g) => `You appear to be in ${g.region}. We only identify people who live in Texas for now.`,
};

/**
 * Would we even try to identify this visit? A thin wrapper over the shared policy (src/policy.ts)
 * that adds a plain-English line for the public demo card, so the page never promises something
 * the pipeline does not do.
 */
export function resolveVerdict(g: GateInput, allowed: readonly string[] = ALLOWED_STATES): Verdict {
  if (g.local) return { wouldTry: false, reason: 'local_dev', why: 'This is local dev, so there is no network data. Run this on the deployed URL to see real values.' };
  const gate = identityGate({ gpc: g.gpc, country: g.country, region: g.region, asnClass: g.asnClass, bot: g.bot }, allowed);
  if (!gate.ok) return { wouldTry: false, reason: gate.reason, why: WHY[gate.reason](g) };
  // An unknown region passes gate 1 (common on cell data and IPv6), so never claim Texas for it.
  if (!stateCode(g.region)) return { wouldTry: true, reason: null, why: 'We could not tell which state you are in, so we would try.' };
  return { wouldTry: true, reason: null, why: 'You appear to be in Texas, so we would try. Our identity partner matches a browser cookie against its own records; if it finds no match, you stay anonymous.' };
}
