/**
 * The lead card: what a contractor gets in their inbox. Plain, scannable on a phone,
 * nothing the recipient has to decode. Both HTML and text are rendered from the same data.
 */
import type { LeadPayload } from '../delivery';
import { hailHtml, hailSubjectBit, hailText, type HailFacts } from './hail';
import { intentLine, type Intent } from '../intent';

export interface LeadCardInput {
  payload: LeadPayload;
  siteName: string;
  /** Paths the visitor looked at, most recent first. */
  pages: string[];
  /** City/region Cloudflare saw the connection from. */
  connection: { city: string | null; region: string | null } | null;
  /** True while the identity provider is the mock. Puts a loud banner on the card. */
  mock: boolean;
  /** Days we keep looking for a fuller match on a return visit. Shown on partial cards. */
  recheckDays?: number;
  /** Repeat visits and high-intent pages. Optional so old callers still render. */
  intent?: Intent;
  /** Where the contractor can see all their leads. Optional until the dashboard exists. */
  dashboardUrl?: string;
  /** Hail near the home. Undefined leaves the hail box off (scoring did not run). */
  hail?: HailFacts;
  /** Clock for "6 hours ago". Tests pin it. */
  now?: number;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

export function fullName(p: LeadPayload): string {
  return [p.first_name, p.last_name].filter(Boolean).join(' ') || 'Name not available';
}

export function addressLine(p: LeadPayload): string {
  const street = [p.address_line1, p.address_line2].filter(Boolean).join(', ');
  const cityState = [p.city, p.state].filter(Boolean).join(', ');
  return [street, cityState, p.zip].filter(Boolean).join(' · ') || 'Address not available';
}

export function confidenceLabel(c: number | null): string {
  if (c === null) return 'Unknown';
  if (c >= 0.8) return `High (${Math.round(c * 100)}%)`;
  if (c >= 0.6) return `Medium (${Math.round(c * 100)}%)`;
  return `Low (${Math.round(c * 100)}%)`;
}

/** What a partial card says up top: what we have, and that we keep looking. */
export function partialNote(input: LeadCardInput): string {
  const p = input.payload;
  const have = [p.email ? 'an email' : '', p.phone ? 'a phone number' : '', p.first_name || p.last_name ? 'a name' : ''].filter(Boolean);
  const what = have.length ? have.join(' and ') : 'only part of a match';
  const days = input.recheckDays ?? 7;
  return `Partial lead: we have ${what}, but no ${p.first_name || p.last_name ? 'street address' : 'name or street address'} yet. If they come back to your site in the next ${days} days, we look again and send a full card.`;
}

export function leadSubject(input: LeadCardInput): string {
  const p = input.payload;
  const where = p.city ? `, ${p.city}` : '';
  const who = p.partial && !(p.first_name || p.last_name) ? (p.email ?? 'visitor') : fullName(p);
  const hail = hailSubjectBit(input.hail, input.now ?? Date.now());
  return `${input.mock ? '[TEST] ' : ''}${p.partial ? 'Partial lead' : 'New lead'}: ${who}${where}${hail ? ` · ${hail}` : ''} · ${input.siteName}`;
}

export function leadText(input: LeadCardInput): string {
  const p = input.payload;
  // null = a line this card does not have; '' = a deliberate blank line.
  const lines: (string | null)[] = [
    input.mock ? 'TEST LEAD. This is a made-up person from the mock provider. Do not call it.' : null,
    p.partial ? partialNote(input) : null,
    `${p.partial ? 'Partial lead' : 'New lead'} from ${input.siteName}`,
    '',
    `Name:       ${fullName(p)}`,
    `Address:    ${addressLine(p)}`,
    ...hailText(input.hail, input.now ?? Date.now()),
    `Phone:      ${p.phone ?? 'not available'}`,
    `Email:      ${p.email ?? 'not available'}`,
    `Confidence: ${confidenceLabel(p.confidence)}`,
    input.intent ? `Intent:     ${intentLine(input.intent)}` : null,
    `Pages:      ${input.pages.length ? input.pages.join(', ') : 'not recorded'}`,
    `Connection: ${input.connection?.city ? [input.connection.city, input.connection.region].filter(Boolean).join(', ') : 'unknown'}`,
    `Seen:       ${p.created_at}`,
    '',
    input.dashboardUrl ? `All leads: ${input.dashboardUrl}` : null,
    'Sent by Yardsign.',
  ];
  return lines.filter((l): l is string => l !== null).join('\n');
}

export function leadHtml(input: LeadCardInput): string {
  const p = input.payload;
  const row = (k: string, v: string) =>
    `<tr><td style="padding:6px 12px 6px 0;color:#5b6a62;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:6px 0;color:#16211b">${v}</td></tr>`;
  const banner = input.mock
    ? `<div style="background:#fbead0;border:1px solid #c77a10;color:#5a3708;padding:10px 14px;border-radius:6px;margin-bottom:16px;font-weight:600">TEST LEAD. This is a made-up person from the mock provider. Do not call it.</div>`
    : '';
  const partial = p.partial
    ? `<div style="background:#e8f0fb;border:1px solid #1f5fbf;color:#123a73;padding:10px 14px;border-radius:6px;margin-bottom:16px">${esc(partialNote(input))}</div>`
    : '';
  const pages = input.pages.length ? input.pages.map((x) => `<code>${esc(x)}</code>`).join(', ') : 'not recorded';
  const conn = input.connection?.city ? esc([input.connection.city, input.connection.region].filter(Boolean).join(', ')) : 'unknown';
  const tel = p.phone ? `<a href="tel:${esc(p.phone.replace(/[^\d+]/g, ''))}" style="color:#1f5fbf">${esc(p.phone)}</a>` : 'not available';
  const mail = p.email ? `<a href="mailto:${esc(p.email)}" style="color:#1f5fbf">${esc(p.email)}</a>` : 'not available';
  return `<!doctype html><html><body style="margin:0;background:#f4f6f2;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.45">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
  ${banner}
  ${partial}
  <div style="background:#fff;border:1px solid #cfd8d1;border-radius:8px;padding:20px 22px">
    <div style="font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#5b6a62;margin-bottom:6px">${p.partial ? 'Partial lead' : 'New lead'} · ${esc(input.siteName)}</div>
    <div style="font-size:24px;font-weight:700;color:#16211b;margin-bottom:2px">${esc(fullName(p))}</div>
    <div style="color:#3b4a42;margin-bottom:14px">${esc(addressLine(p))}</div>
    ${hailHtml(input.hail, input.now ?? Date.now(), esc)}
    <table style="border-collapse:collapse;width:100%">
      ${row('Phone', tel)}
      ${row('Email', mail)}
      ${row('Confidence', esc(confidenceLabel(p.confidence)))}
      ${input.intent ? row('Buying intent', esc(intentLine(input.intent))) : ''}
      ${row('Pages viewed', pages)}
      ${row('Connection', conn)}
      ${row('Seen', esc(p.created_at))}
    </table>
    ${input.dashboardUrl ? `<p style="margin:16px 0 0"><a href="${esc(input.dashboardUrl)}" style="color:#1f5fbf">See all your leads</a></p>` : ''}
  </div>
  <p style="color:#6b7a72;font-size:13px;margin:14px 0 0">Sent by Yardsign. Reply to this email if something looks wrong.</p>
</div>
</body></html>`;
}

/** "They're back": a known lead returned to the site. Short on purpose; the first card has the details. */
export interface ReturnAlertInput {
  payload: LeadPayload;
  siteName: string;
  intent: Intent;
  /** Paths from this latest visit. */
  pages: string[];
  mock: boolean;
}

function returnWho(p: LeadPayload): string {
  return p.first_name || p.last_name ? fullName(p) : (p.email ?? 'A visitor you already have');
}

export function returnSubject(input: ReturnAlertInput): string {
  return `${input.mock ? '[TEST] ' : ''}Back on your site: ${returnWho(input.payload)} · ${input.siteName}`;
}

export function returnText(input: ReturnAlertInput): string {
  const p = input.payload;
  return [
    input.mock ? 'TEST LEAD. This is a made-up person from the mock provider. Do not call it.' : null,
    `${returnWho(p)} just came back to ${input.siteName}. People who come back are closer to hiring someone, so this is a good time to reach out.`,
    '',
    `Intent:  ${intentLine(input.intent)}`,
    `Pages:   ${input.pages.length ? input.pages.join(', ') : 'not recorded'}`,
    `Phone:   ${p.phone ?? 'not available'}`,
    `Email:   ${p.email ?? 'not available'}`,
    '',
    'Sent by Yardsign.',
  ]
    .filter((l): l is string => l !== null)
    .join('\n');
}

export function returnHtml(input: ReturnAlertInput): string {
  const p = input.payload;
  const row = (k: string, v: string) =>
    `<tr><td style="padding:6px 12px 6px 0;color:#5b6a62;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:6px 0;color:#16211b">${v}</td></tr>`;
  const banner = input.mock
    ? `<div style="background:#fbead0;border:1px solid #c77a10;color:#5a3708;padding:10px 14px;border-radius:6px;margin-bottom:16px;font-weight:600">TEST LEAD. This is a made-up person from the mock provider. Do not call it.</div>`
    : '';
  const tel = p.phone ? `<a href="tel:${esc(p.phone.replace(/[^\d+]/g, ''))}" style="color:#1f5fbf">${esc(p.phone)}</a>` : 'not available';
  const mail = p.email ? `<a href="mailto:${esc(p.email)}" style="color:#1f5fbf">${esc(p.email)}</a>` : 'not available';
  const pages = input.pages.length ? input.pages.map((x) => `<code>${esc(x)}</code>`).join(', ') : 'not recorded';
  return `<!doctype html><html><body style="margin:0;background:#f4f6f2;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.45">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
  ${banner}
  <div style="background:#fff;border:1px solid #cfd8d1;border-radius:8px;padding:20px 22px">
    <div style="font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#5b6a62;margin-bottom:6px">Back on your site · ${esc(input.siteName)}</div>
    <div style="font-size:24px;font-weight:700;color:#16211b;margin-bottom:8px">${esc(returnWho(p))}</div>
    <p style="margin:0 0 14px;color:#3b4a42">People who come back are closer to hiring someone. This is a good time to reach out.</p>
    <table style="border-collapse:collapse;width:100%">
      ${row('Buying intent', esc(intentLine(input.intent)))}
      ${row('Pages', pages)}
      ${row('Phone', tel)}
      ${row('Email', mail)}
    </table>
  </div>
  <p style="color:#6b7a72;font-size:13px;margin:14px 0 0">Sent by Yardsign. At most one of these per visitor per day.</p>
</div>
</body></html>`;
}
