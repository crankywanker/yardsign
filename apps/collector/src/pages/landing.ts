/** The marketing page with the live demo card. Ported from the old app; copy unchanged. */
import { html } from 'hono/html';
import type { DemoView, Verdict } from '../demo';
import { PLANS, type PlanId } from '../plans';
import { canonicalUrl } from '../seo';
import { page, type Html } from './layout';

const dash = (v: string | number | null | undefined): string => (v === undefined || v === null || v === '' ? '—' : String(v));

function demoCard(d: DemoView, v: Verdict): Html {
  const rows: Array<[string, string, string | null]> = [
    ['City', 'city', d.city],
    ['State', 'state', d.state],
    ['ZIP', 'zip', d.zip],
    ['Internet provider', 'isp', d.isp],
    ['Network type', 'network', d.network],
    ['Device', 'device', d.device],
    ['Browser', 'browser', d.browser],
    ['Local time', 'localTime', d.localTime],
  ];
  return html`<div class="card" id="demo">
  <div class="row" style="justify-content:space-between;margin-bottom:12px">
    <h2 style="margin:0;font-size:1.2rem">Here's what we can tell about <em>you</em> right now.</h2>
    <button class="btn sec sm" id="demo-refresh" type="button">Refresh</button>
  </div>
  ${d.local ? html`<div class="banner info small">Run this on the deployed URL to see real values. Local dev has no network data.</div>` : ''}
  <dl class="rows">
    ${rows.map(([label, key, val]) => html`<dt>${label}</dt><dd data-f="${key}">${dash(val)}</dd>`)}
  </dl>
  <div class="verdict ${v.wouldTry ? 'yes' : 'no'}" id="demo-verdict">
    <span data-f="verdictHead">${v.wouldTry ? '✅ We would try to identify this visit.' : '⛔ We would not try to identify this visit.'}</span>
    <span class="small" style="display:block;font-weight:500" data-f="why">${v.why}</span>
  </div>
  <p class="small muted" style="margin:12px 0 0">We only show you <em>this</em> on a public page. Names and addresses go to the account owner, never to the visitor.</p>
</div>
<script>
document.getElementById('demo-refresh').addEventListener('click',function(){var b=this;b.disabled=true;
fetch('/demo.json',{cache:'no-store'}).then(function(r){return r.json()}).then(function(j){if(!j||!j.view)return;var d=j.view,v=j.verdict;
var map={city:d.city,state:d.state,zip:d.zip,isp:d.isp,network:d.network,device:d.device,browser:d.browser,localTime:d.localTime,
verdictHead:v.wouldTry?'✅ We would try to identify this visit.':'⛔ We would not try to identify this visit.',why:v.why};
Object.keys(map).forEach(function(k){var el=document.querySelector('[data-f="'+k+'"]');if(el)el.textContent=map[k]||'—'});
document.getElementById('demo-verdict').className='verdict '+(v.wouldTry?'yes':'no')}).finally(function(){b.disabled=false})});
</script>`;
}

function planCard(id: PlanId, note: string): Html {
  const p = PLANS[id];
  return html`<div class="card">
  <h3>${p.name}</h3>
  <div class="price">$${p.price}<span class="muted" style="font-size:1rem;font-weight:600">/mo</span></div>
  <p class="muted">Up to ${p.quota} identified households a month. ${note}</p>
  <form method="post" action="/checkout">
    <input type="hidden" name="plan" value="${id}">
    <label for="email-${id}">Your email</label>
    <input id="email-${id}" name="email" type="email" required autocomplete="email" placeholder="you@yourroofing.com">
    <label for="domain-${id}">Your website</label>
    <input id="domain-${id}" name="domain" required placeholder="yourroofing.com" autocomplete="url">
    <button class="btn" style="width:100%;margin-top:14px" type="submit">Start ${p.name}</button>
  </form>
  <p class="small muted" style="margin:10px 0 0">Cancel anytime.</p>
</div>`;
}

export function landingPage(app: string, d: DemoView, v: Verdict, head?: string): Html {
  const body = html`
<section class="hero grid g2" style="align-items:start">
  <div>
    <h1>Know who drove past.</h1>
    <p class="lead">See the homeowners who visit your website — name, address, phone, recent hail — in your CRM within a minute.</p>
    <div class="row"><a class="btn" href="#pricing">See pricing</a><a class="btn sec" href="#how">How it works</a></div>
  </div>
  ${demoCard(d, v)}
</section>

<section id="how">
  <h2>How it works</h2>
  <div class="grid g2">
  <ol class="steps">
    <li><strong>Add one line to your website.</strong><br><span class="muted">Copy and paste it once. It works with WordPress, Wix, Squarespace, and anything else.</span></li>
    <li><strong>A homeowner visits and looks around.</strong><br><span class="muted">We record the pages they view and how long they stay. Bots are ignored.</span></li>
    <li><strong>We figure out which household it is.</strong><br><span class="muted">Only for people in Texas. Every lead shows how sure we are.</span></li>
    <li><strong>The lead shows up in your inbox or CRM.</strong><br><span class="muted">Email, GoHighLevel, Zapier, Slack, or any webhook. Usually within a few minutes.</span></li>
  </ol>
  <div class="card example">
    <h3 style="margin-bottom:12px">What you get</h3>
    <dl class="rows">
      <dt>Name</dt><dd>Maria Garcia</dd>
      <dt>Address</dt><dd>[Mailing address]</dd>
      <dt>Phone</dt><dd>(972) 555-0142</dd>
      <dt>Hail</dt><dd>1.75" hail, 1.2 mi away, 9 days ago <span class="muted small">(National Weather Service report)</span></dd>
      <dt>Looked at</dt><dd>/roof-replacement, /financing, /storm-damage</dd>
      <dt>Confidence</dt><dd><span class="pill high">High</span> <span class="small muted">home connection, ZIP matches</span></dd>
    </dl>
  </div>
  </div>
</section>

<section>
  <h2>Why roofers use it</h2>
  <p style="font-size:1.15rem;max-width:40em">You pay $75–$300 for a shared Angi lead. This one came to <em>your</em> site, and nobody else gets it.</p>
  <p class="muted" style="max-width:40em">Most people who visit a roofer's site never fill out the form. They look at prices, check your reviews, and leave. Now you can call them back.</p>
</section>

<section id="pricing">
  <h2>Pricing</h2>
  <div class="grid g2">
    ${planCard('starter', 'Good for one crew.')}
    ${planCard('pro', 'For busy seasons and more than one city.')}
  </div>
</section>

<section id="faq" class="narrow">
  <h2>Questions</h2>
  <details><summary>Is this legal?</summary><p>We only identify people who live in Texas. We honor opt-outs and the Global Privacy Control signal. You add one paragraph to your privacy policy — we give you the text.</p></details>
  <details><summary>Does it work on phones?</summary><p>Yes, on wifi or cell data. Android phones match about as often as computers. iPhones match much less often, because Safari clears cookies after a few days.</p></details>
  <details><summary>How accurate is it?</summary><p>We show you our match rate on <em>your</em> traffic, and every lead comes with a confidence level and the reasons, so you know which ones to call first.</p></details>
  <details><summary>What if I go over my plan?</summary><p>We keep collecting, but stop sending leads until next month or until you upgrade. You'll see a notice on your dashboard.</p></details>
  <details><summary>Can people opt out?</summary><p>Yes. Anyone can opt out at <a href="/optout">/optout</a>, and we delete what we have about them.</p></details>
</section>`;
  return page({
    title: `${app} — Know who drove past`,
    app,
    description: 'See the homeowners who visit your website — name, address, phone, recent hail — in your CRM within a minute.',
    canonical: canonicalUrl('/'),
    nav: html`<nav><a href="#how">How it works</a><a href="#pricing">Pricing</a><a href="#faq">FAQ</a></nav>`,
    body,
    head,
  });
}
