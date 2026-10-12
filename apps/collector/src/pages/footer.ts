/**
 * The site footer: one data list of links, rendered on every public page and the HTML 404.
 * Never on the dashboard, the operator page or the after-checkout page (those get `appFooter`).
 *
 * Two jobs: help a roofer find the next page, and give Google and AI search tools a link to
 * every important page from every page. A footer full of dead links hurts, so only `live: true`
 * links render. The rest of the list is the target layout: as a page ships, flip its link on.
 * A column with nothing live does not render at all.
 */
import { html, raw } from 'hono/html';

export type FooterColumn = 'Product' | 'Send leads to' | 'Install on' | 'Learn' | 'Free tools' | 'Compare' | 'Trust';

export interface FooterLink {
  column: FooterColumn;
  label: string;
  /** A path on this site, or a same-page anchor on the home page like "/#pricing". */
  href: string;
  /** Only live links render. Flip to true when the page exists and returns 200. */
  live: boolean;
}

/** One sentence for people and for AI tools. Plain and factual. */
export const BRAND_SENTENCE = 'Yardsign shows Texas roofers which homeowners visited their website, then sends each lead to email or their CRM within minutes.';

export const FOOTER_LINKS: FooterLink[] = [
  // Product
  { column: 'Product', label: 'How it works', href: '/#how', live: true },
  { column: 'Product', label: 'Pricing', href: '/#pricing', live: true },
  { column: 'Product', label: 'Live demo: what we can see about you', href: '/#demo', live: true },
  { column: 'Product', label: 'FAQ', href: '/#faq', live: true },
  { column: 'Product', label: 'Integrations', href: '/integrations', live: false },
  { column: 'Product', label: 'Install guide', href: '/install', live: false },
  { column: 'Product', label: 'Log in', href: '/app', live: true },
  // Send leads to
  { column: 'Send leads to', label: 'GoHighLevel', href: '/integrations/gohighlevel', live: false },
  { column: 'Send leads to', label: 'Zapier', href: '/integrations/zapier', live: false },
  { column: 'Send leads to', label: 'Slack', href: '/integrations/slack', live: false },
  { column: 'Send leads to', label: 'Email', href: '/integrations/email', live: false },
  { column: 'Send leads to', label: 'Webhook', href: '/integrations/webhook', live: false },
  // Install on
  { column: 'Install on', label: 'WordPress', href: '/install/wordpress', live: false },
  { column: 'Install on', label: 'Wix', href: '/install/wix', live: false },
  { column: 'Install on', label: 'Squarespace', href: '/install/squarespace', live: false },
  // Learn
  { column: 'Learn', label: 'All guides', href: '/learn', live: false },
  { column: 'Learn', label: 'FAQ', href: '/faq', live: false },
  { column: 'Learn', label: 'Who visited my site?', href: '/learn/who-visited-my-roofing-website', live: false },
  { column: 'Learn', label: 'How fast to call back', href: '/learn/how-fast-to-call-back-a-web-lead', live: false },
  { column: 'Learn', label: 'Why visitors skip the form', href: '/learn/why-visitors-skip-the-form', live: false },
  { column: 'Learn', label: 'What to say when you call', href: '/learn/what-to-say-when-you-call', live: false },
  // Free tools
  { column: 'Free tools', label: 'Lead cost calculator', href: '/tools/lead-cost-calculator', live: false },
  { column: 'Free tools', label: 'Is my tracking code installed?', href: '/tools/pixel-checker', live: false },
  // Compare
  { column: 'Compare', label: 'Your visitors vs Angi leads', href: '/compare/angi-leads', live: false },
  { column: 'Compare', label: 'Yardsign vs RB2B', href: '/compare/rb2b', live: false },
  { column: 'Compare', label: 'Yardsign vs Leadpipe', href: '/compare/leadpipe', live: false },
  // Trust
  { column: 'Trust', label: 'How we protect homeowners', href: '/how-we-protect-homeowners', live: false },
  { column: 'Trust', label: 'Privacy', href: '/privacy', live: true },
  { column: 'Trust', label: 'Terms', href: '/terms', live: true },
  { column: 'Trust', label: 'Opt out', href: '/optout', live: true },
  { column: 'Trust', label: 'Do not sell or share my info', href: '/optout', live: true },
  { column: 'Trust', label: 'Texas data broker notice', href: '/data-broker', live: false },
];

/**
 * Plain text that stands in for a column's links until those pages ship. Shown under the
 * column heading only while that column has no live links, so it goes away by itself.
 */
export const FOOTER_TEXT: Partial<Record<FooterColumn, string[]>> = {
  'Send leads to': ['Email · GoHighLevel · Slack · Zapier · Webhook', 'Works on WordPress, Wix, Squarespace and any site'],
};

/**
 * Desktop layout, left to right. Columns in the same cell stack under each other
 * ("Install on" sits under "Send leads to"). A cell with nothing to show is skipped.
 */
export const FOOTER_CELLS: FooterColumn[][] = [['Product'], ['Send leads to', 'Install on'], ['Learn'], ['Free tools'], ['Compare'], ['Trust']];

/** The two buttons in the target layout's top row. Off until the layout grows past v1. */
export const FOOTER_BUTTONS: { live: boolean; primary: { label: string; href: string }; secondary: { label: string; href: string } } = {
  live: false,
  primary: { label: 'See pricing', href: '/#pricing' },
  secondary: { label: 'See what your site can see', href: '/#demo' },
};

/**
 * The one-line trust strip above the copyright. On since Oct 7, 2026: each claim is enforced in
 * src/policy.ts (GPC and Texas-only at the pixel and at delivery) and in the opt-out route.
 * Change the text only together with the code that makes it true.
 */
export const TRUST_STRIP: { live: boolean; text: string } = {
  live: true,
  text: 'We honor Global Privacy Control · Texas homeowners only · opt-out deletes every lead',
};


/** The links that render, in list order. */
export function liveFooterLinks(links: FooterLink[] = FOOTER_LINKS): FooterLink[] {
  return links.filter((l) => l.live);
}

function columnBlock(column: FooterColumn, links: FooterLink[], text: string[]) {
  if (links.length === 0 && text.length === 0) return null;
  return html`<div class="fcol">
<h2>${column}</h2>
${links.map((l) => html`<a href="${l.href}">${l.label}</a>`)}
${text.map((t) => html`<p>${t}</p>`)}
</div>`;
}

/** The dark site footer. Only live links, only columns with something in them. */
export function siteFooter(app: string, links: FooterLink[] = FOOTER_LINKS): ReturnType<typeof html> {
  const live = liveFooterLinks(links);
  const block = (col: FooterColumn) => {
    const links = live.filter((l) => l.column === col);
    return columnBlock(col, links, links.length === 0 ? (FOOTER_TEXT[col] ?? []) : []);
  };
  const cells = FOOTER_CELLS.map((cell) => cell.map(block).filter((b) => b !== null)).filter((cell) => cell.length > 0);
  // Up to three link columns share a row with the brand block; more than that and the brand gets its own row.
  const brandInGrid = cells.length <= 3;
  // Phones: the primary button first. Desktop: secondary then primary, as in the mockup.
  const buttons = FOOTER_BUTTONS.live
    ? html`<div class="fbtns"><a class="primary" href="${FOOTER_BUTTONS.primary.href}">${FOOTER_BUTTONS.primary.label}</a><a class="secondary" href="${FOOTER_BUTTONS.secondary.href}">${FOOTER_BUTTONS.secondary.label}</a></div>`
    : '';
  const brand = html`<div class="fbrand">
<a class="flogo" href="/">${raw(SIGN_ICON)}<span>${app}</span></a>
<p>${BRAND_SENTENCE}</p>
${brandInGrid ? buttons : ''}
</div>`;
  const year = new Date().getUTCFullYear();
  return html`<footer class="site print-hide"><div class="fwrap">
<div class="ftop ${brandInGrid ? 'inline' : 'stacked'}" style="--fcols:${cells.length + (brandInGrid ? 1 : 0)}">
${brandInGrid ? brand : html`<div class="fhead">${brand}${buttons}</div>`}
<nav aria-label="Footer" class="fnav" style="--fcols:${cells.length}">
${cells.map((cell) => html`<div class="fcell">${cell}</div>`)}
</nav>
</div>
<div class="fbottom">
${TRUST_STRIP.live ? html`<p class="ftrust">${TRUST_STRIP.text}</p>` : ''}
<div class="frow"><span>© ${year} ${app} · Built in Texas</span><span class="flinks"><a href="/sitemap.xml">Sitemap</a><a href="/llms.txt">AI assistants: read our llms.txt</a></span></div>
</div>
</div></footer>`;
}

/** The yard-sign icon from the mockup: an outlined sign on two legs, in the hero's orange. */
const SIGN_ICON = '<svg viewBox="0 0 34 34" fill="none" stroke="#E9893D" stroke-width="2.5" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="6" width="24" height="15" rx="2"></rect><path d="M11 21v9M23 21v9"></path></svg>';

/** The small footer for the dashboard, the operator page and the after-checkout page. Never the site footer. */
export function appFooter(): ReturnType<typeof html> {
  return html`<footer class="bottom print-hide"><div class="wrap">
<a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/optout">Opt out</a>
</div></footer>`;
}
