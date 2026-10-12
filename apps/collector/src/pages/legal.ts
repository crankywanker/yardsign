/**
 * DRAFT legal copy, written for an 8th-grade reader. Not legal advice. The privacy page and the
 * roofer paragraph were rewritten Oct 7, 2026 for the Texas-only rule (src/policy.ts); every
 * promise here must match what that file and the opt-out route do. Have the privacy lawyer review all three pages before the first
 * non-friendly customer. Placeholders in [brackets] must be filled in by the owner.
 */
import { html } from 'hono/html';
import { COMPANY_LEGAL_NAME } from '../company';
import { canonicalUrl } from '../seo';
import { page, type Html } from './layout';

const COMPANY = `${COMPANY_LEGAL_NAME}, a Texas [LLC]`;
const CONTACT = 'privacy@tryyardsign.com';
const UPDATED = 'October 7, 2026';

/** The paragraph customers must add to their own privacy policy. */
export function disclosureText(app: string, appUrl: string): string {
  return `We use ${app} to learn which homeowners visit our website, so we can follow up about our services. ${app} only tries to identify people who live in Texas. When you visit, ${app}'s identity partner places a cookie in your browser and matches it to its own records to find your name, address, phone number or email. ${app} then sells that information to us. If you live outside Texas, ${app} does not send us your information. If your browser sends a Global Privacy Control signal, ${app} does not try to identify you. You can opt out at any time at ${appUrl}/optout.`;
}

export function privacyPage(app: string): Html {
  return page({
    title: `Privacy — ${app}`,
    app,
    canonical: canonicalUrl('/privacy'),
    description: `Who ${app} identifies, what it collects about website visitors, who gets it, and how to opt out.`,
    body: html`<div class="narrow">
<h1>Privacy policy</h1>
<p class="muted">Last updated ${UPDATED}. ${app} is run by ${COMPANY}.</p>

<h2>What ${app} does</h2>
<p>${app} helps home-service companies, like roofers, learn which homeowners visited their website, so they can follow up. Our customers add a small piece of code to their websites. When you visit one of those sites, the code tells us.</p>

<h2>Who we identify</h2>
<p>We only try to identify people in Texas: people whose home is in Texas, or who visit from Texas. If neither is true, we do not send your information to anyone.</p>

<h2>How it works</h2>
<p>When you visit a website that uses ${app}, our identity partner places a cookie in your browser and matches it to its own records to find a name, address, phone number or email. Our identity partner shares identifiers with its own partners to do this.</p>
<p>Our identity partner may use information from website visits, with the website's name removed, to improve its own services.</p>

<h2>What we collect</h2>
<ul>
<li><strong>From the visit:</strong> your IP address (after 72 hours we keep only a scrambled version), your internet provider, rough location (city, state, ZIP), device and browser type, the pages you looked at, and a cookie that lets us recognize your browser next time.</li>
<li><strong>From our identity partner:</strong> a name, mailing address, phone number and email, when it finds a match.</li>
<li><strong>From public records:</strong> we may add public property information, like the year a home was built.</li>
</ul>

<h2>What we do not collect</h2>
<p>We do not collect health information, race, religion, your device's precise location, or information about children.</p>

<h2>Who gets it</h2>
<p>We sell this information to the business whose website you visited, usually a roofing company, so it can contact you. We do not sell it to any other business, and we never show a visitor's identity on a public page. We also use service providers (hosting, email, payments, our identity partner) who work for us under contract. To show the business whether hail fell near your home, we send your street address, and nothing else about you, to the U.S. Census Bureau's free address lookup, which turns it into a map point.</p>

<h2>Global Privacy Control</h2>
<p>If your browser sends Global Privacy Control, we do not load our identity partner and we do not identify you.</p>

<h2>How long we keep it</h2>
<p>Visit records: up to 13 months. Matches: for as long as the business keeps its account. If a match lives outside Texas and did not visit from Texas, we never send it, and we delete its details within 30 days. Opt-out records: forever, so we keep honoring them.</p>

<h2>Opt out</h2>
<p><a href="/optout">Opt out here.</a> Opting out deletes every lead about you that we hold and tells each roofer who received one to delete it within 10 business days. We will also stop identifying you on every site that uses ${app}. To ask what we have about you, email <a href="mailto:${CONTACT}">${CONTACT}</a>.</p>

<h2>Texas data broker notice</h2>
<p>Texas data broker registration no. [TX data broker registration no.].</p>

<h2>Contact</h2>
<p>${COMPANY}, [mailing address]. <a href="mailto:${CONTACT}">${CONTACT}</a>.</p>
</div>`,
  });
}

export function termsPage(app: string, appUrl: string): Html {
  return page({
    title: `Terms — ${app}`,
    app,
    canonical: canonicalUrl('/terms'),
    description: `The rules for businesses that use ${app} on their website.`,
    body: html`<div class="narrow">
<h1>Terms of service</h1>
<p class="muted">Last updated ${UPDATED}. These terms are between you (the business using ${app}) and ${COMPANY}.</p>

<h2>1. The service</h2>
<p>${app} gives you code to put on your website and sends you information about households that visit it. Matches are not guaranteed. Each lead comes with a confidence level; use your judgment.</p>

<h2>2. What you must do</h2>
<ul>
<li>Only install the code on websites you own or control.</li>
<li>Add this paragraph (or one your lawyer approves that says the same thing) to your website's privacy policy before you install the code:
<blockquote class="card small">${disclosureText(app, appUrl)}</blockquote></li>
<li>Follow the law when you contact people, including the Telephone Consumer Protection Act, the National Do Not Call Registry, Texas telemarketing rules, and CAN-SPAM.</li>
<li>Use leads only to offer your own services. Do not resell or share them.</li>
<li>Delete a person's information if they ask you to, and tell us so we can delete ours. When we tell you a person opted out, delete their information within 10 business days.</li>
</ul>

<h2>3. Billing</h2>
<p>Plans are billed monthly in advance through Stripe. You can cancel anytime; you keep access until the end of the paid month. If you go over your plan's household limit, we stop sending new leads until the next month or until you upgrade. No refunds for partial months.</p>

<h2>4. Things we don't promise</h2>
<p>The service is provided "as is." We are not liable for lost profits or indirect damages. Our total liability is limited to what you paid us in the last 3 months.</p>

<h2>5. Ending</h2>
<p>We may suspend accounts that break these terms or the law. You can cancel at any time.</p>

<h2>6. Law</h2>
<p>Texas law applies. [Venue county to be confirmed.]</p>

<p class="muted">Questions: <a href="mailto:${CONTACT}">${CONTACT}</a></p>
</div>`,
  });
}

export function optoutPage(app: string, state: 'form' | 'done' | 'error', msg = ''): Html {
  const body =
    state === 'done'
      ? html`<div class="narrow"><h1>You're opted out.</h1>
<p>We deleted every lead tied to that email, and ${app} will not identify you on any customer's site again.</p>
<p class="muted">We also told each business that received a lead about you to delete it within 10 business days.</p>
<p><a href="/">Back to home</a></p></div>`
      : html`<div class="narrow"><h1>Opt out</h1>
<p>Enter your email. We will delete every lead tied to it, tell each business that received one to delete it within 10 business days, and never identify you again on any site that uses ${app}.</p>
<p class="muted small">We store only a one-way scrambled version of your email (a hash), so we can keep honoring your request without keeping the email itself.</p>
${state === 'error' ? html`<div class="banner bad">${msg}</div>` : ''}
<form method="post" action="/optout" class="card">
  <label for="email">Email</label>
  <input id="email" name="email" type="email" required autocomplete="email">
  <button class="btn" style="margin-top:14px" type="submit">Opt me out</button>
</form>
<p class="small muted" style="margin-top:16px">You can also turn on Global Privacy Control in your browser; we honor it on every visit.</p>
</div>`;
  return page({ title: `Opt out — ${app}`, app, body, noindex: state !== 'form', canonical: state === 'form' ? canonicalUrl('/optout') : undefined, description: state === 'form' ? `Ask ${app} to delete your matches and never identify you on any site that uses it.` : undefined });
}

export function messagePage(app: string, title: string, message: string, status: 'bad' | 'info' = 'info'): Html {
  return page({ title: `${title} — ${app}`, app, noindex: true, body: html`<div class="narrow"><h1>${title}</h1><div class="banner ${status}">${message}</div><p><a href="/">Back to home</a></p></div>` });
}

/** The HTML 404. Status comes from the route; this is only the body. */
export function notFoundPage(app: string): Html {
  return page({
    title: `Page not found — ${app}`,
    app,
    noindex: true,
    body: html`<div class="narrow"><h1>Page not found</h1><p>There is no page at this address. It may have moved, or the link may have a typo.</p><p><a class="btn" href="/">Go to the home page</a></p></div>`,
  });
}
