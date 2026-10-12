import { html } from 'hono/html';
import type { Site } from '@yardsign/db';
import { page, type Html } from './layout';

/** Seconds between reloads while the payment goes through. */
export const WELCOME_REFRESH_S = 5;

/**
 * After checkout: the install tag, where leads go, what to do next. While the payment is still
 * going through, the page reloads itself to `refreshUrl`; with no `refreshUrl` it stops and says so.
 * A site waiting for the operator (review) shows no tag and no dashboard link.
 */
export function welcomePage(app: string, baseUrl: string, site: Site | null, pending: boolean, err?: string, refreshUrl?: string | null): Html {
  if (err) {
    return page({ title: `Welcome — ${app}`, app, noindex: true, footer: 'app', body: html`<div class="narrow"><h1>Something went wrong</h1><div class="banner bad">${err}</div><p>Email us and we'll sort it out.</p></div>` });
  }
  if ((pending || !site) && refreshUrl) {
    return page({
      title: `Welcome — ${app}`,
      app,
      noindex: true,
      footer: 'app',
      body: html`<meta http-equiv="refresh" content="${WELCOME_REFRESH_S}; url=${refreshUrl}"><div class="narrow"><h1>Setting up your account…</h1><p>Your payment is going through. This page will refresh in a few seconds.</p></div>`,
    });
  }
  if (pending || !site) {
    return page({
      title: `Welcome — ${app}`,
      app,
      noindex: true,
      footer: 'app',
      body: html`<div class="narrow"><h1>Your payment is still processing</h1><p>This is taking longer than usual. Some ways to pay take a few days to clear.</p><p>Bookmark this page and open it again later. Your setup will show here once the payment clears. Questions? Email <a href="mailto:hello@tryyardsign.com">hello@tryyardsign.com</a>.</p></div>`,
    });
  }
  if (site.reviewReason) {
    return page({
      title: `Welcome — ${app}`,
      app,
      noindex: true,
      footer: 'app',
      body: html`<div class="narrow"><h1>Thanks, your payment went through.</h1><p>We need to finish setting up your account by hand. We will do that by email, so watch your inbox. You don't need to do anything now.</p><p>Questions? Email <a href="mailto:hello@tryyardsign.com">hello@tryyardsign.com</a>.</p></div>`,
    });
  }
  const tag = `<script async src="${baseUrl}/p/${site.siteKey}.js"></script>`;
  const domain = site.allowedDomains[0] ?? site.name;
  return page({
    title: `Welcome — ${app}`,
    app,
    noindex: true,
    footer: 'app',
    body: html`<div class="narrow">
<h1>You're in.</h1>
<p>Here's your one line for <strong>${domain}</strong>. Paste it just before <code>&lt;/head&gt;</code> on every page.</p>
<pre id="snippet">${tag}</pre>
<button class="btn sm" type="button" data-copy="#snippet">Copy snippet</button>
<div class="card" style="margin-top:24px">
  <h2 style="font-size:1.1rem">Where your leads go</h2>
  <p>Each lead lands in your inbox at <strong>${site.leadEmail ?? 'the email you paid with'}</strong> as a card with the name, address, phone and the pages they looked at. Reply to any card to reach us.</p>
</div>
<div class="card" style="margin-top:16px">
  <h2 style="font-size:1.1rem">One more thing</h2>
  <p>Add this paragraph to your website's privacy policy. It is in our <a href="/terms">terms</a>, under "What you must do".</p>
</div>
<div class="card" style="margin-top:16px">
  <h2 style="font-size:1.1rem">Your dashboard</h2>
  <p>Bookmark this link. It is your private key to your leads. Don't share it.</p>
  <pre id="dash">${baseUrl}/app?key=${site.dashKey ?? ''}</pre>
  <div class="row"><a class="btn" href="/app?key=${site.dashKey ?? ''}">Open dashboard</a><button class="btn sec" type="button" data-copy="#dash">Copy link</button></div>
</div>
</div>`,
  });
}
