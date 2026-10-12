/** The customer dashboard: leads, install, delivery. One site at a time. Ported and simplified from the old app. */
import { html, raw } from 'hono/html';
import type { AccountRow, DeliveryRow, LeadRow, Site } from '@yardsign/db';
import { agoLabel, inchesLabel, milesLabel, type HailFacts } from '../email/hail';
import type { Stats } from '../stats';
import { page, type Html } from './layout';
import { disclosureText } from './legal';

export interface DashCtx {
  app: string;
  baseUrl: string;
  key: string;
  admin: boolean;
  site: Site;
  account: AccountRow;
  sites: Array<{ id: string; name: string }>;
  mock: boolean;
  print: boolean;
}

/** A dashboard URL that carries the key and, for admins, the selected site. */
export function dashUrl(ctx: Pick<DashCtx, 'key' | 'site' | 'admin'>, path: string, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams({ key: ctx.key, ...(ctx.admin ? { site: ctx.site.id } : {}), ...extra });
  return `${path}?${p.toString()}`;
}

const dash = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : String(v));
const fmtPct = (n: number | null): string => (n === null ? '—' : `${n}%`);
const when = (ms: number | null | undefined): Html => (ms ? html`<time datetime="${new Date(ms).toISOString()}">${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC</time>` : html`—`);

function shell(ctx: DashCtx, active: string, title: string, body: Html): Html {
  const tab = (path: string, label: string) => html`<a href="${dashUrl(ctx, path)}" class="${active === path ? 'on' : ''}">${label}</a>`;
  const nav = html`<nav>
  ${tab('/app', 'Leads')}${tab('/app/install', 'Install')}${tab('/app/delivery', 'Delivery')}
  ${ctx.admin && ctx.sites.length > 1
    ? html`<form method="get" action="${active}" style="margin:0"><input type="hidden" name="key" value="${ctx.key}">
      <select name="site" onchange="this.form.submit()" aria-label="Site" style="padding:6px 8px;width:auto">
        ${ctx.sites.map((s) => html`<option value="${s.id}" ${s.id === ctx.site.id ? 'selected' : ''}>${s.name}</option>`)}
      </select></form>`
    : ''}
  </nav>`;
  return page({
    title: `${title} — ${ctx.app}`,
    app: ctx.app,
    nav,
    noindex: true,
    footer: 'app',
    bodyClass: ctx.print ? 'print' : '',
    body: html`${ctx.mock ? html`<div class="banner info print-hide">Test mode: names, addresses and phones on this page are made up.</div>` : ''}${body}`,
  });
}

function quotaBanner(ctx: DashCtx, st: Stats): Html | '' {
  const q = ctx.account.monthly_quota;
  if (ctx.account.status === 'suspended') return html`<div class="banner bad">Your subscription has ended. We are still counting visits, but not identifying or sending leads.</div>`;
  // Lookups stop at the limit (resolution.ts), so "reached" is the state a customer actually sees.
  if (q > 0 && st.usedThisMonth >= q) return html`<div class="banner warn">You've reached your plan: ${st.usedThisMonth} of ${q} households this month. We stop identifying new visitors until next month. Upgrade or wait for next month.</div>`;
  if (q > 0 && st.usedThisMonth >= q * 0.8) return html`<div class="banner warn">Heads up: ${st.usedThisMonth} of ${q} households used this month.</div>`;
  return '';
}

export function confidenceTier(c: number | null): 'high' | 'medium' | 'low' {
  if (c !== null && c >= 0.8) return 'high';
  if (c !== null && c >= 0.6) return 'medium';
  return 'low';
}

export interface LeadView {
  lead: LeadRow;
  pages: string[];
  delivery: DeliveryRow | null;
  /** Hail near the home from the lead's newest score. Undefined when it was never scored. */
  hail?: HailFacts;
}

export type LeadSort = 'newest' | 'hail';

/** Most hail first: leads with hail by score (ties newest first), then the rest newest first. */
export function sortLeads(views: LeadView[], sort: LeadSort): LeadView[] {
  if (sort !== 'hail') return views;
  const rank = (v: LeadView) => (v.hail?.kind === 'found' ? v.hail.score : -1);
  return [...views].sort((a, b) => rank(b) - rank(a) || b.lead.created_at - a.lead.created_at);
}

/** The hail cell: size and age up front, miles and score under it. Hail from the last two weeks is red. */
function hailCell(h: HailFacts | undefined, now: number): Html | string {
  if (!h || h.kind === 'unknown') return '—';
  if (h.kind === 'none') return html`<span class="small muted">None nearby</span>`;
  const fresh = now - h.at <= 14 * 24 * 60 * 60 * 1000;
  const size = html`<span class="pill ${fresh ? 'low' : 'medium'}">${inchesLabel(h.inches)}</span>`;
  const where = h.fromHome ? `${milesLabel(h.miles)} · ` : '';
  return html`${size} ${agoLabel(h.at, now)}<br><span class="small muted">${where}score ${h.score}</span>`;
}

export function dashboardPage(ctx: DashCtx, st: Stats, leads: LeadView[], sort: LeadSort = 'newest', now = Date.now()): Html {
  const tiles = html`<div class="tiles">
  <div class="tile"><div class="l">Visitors</div><div class="n">${st.visitors}</div><div class="s">unique browsers, 30 days</div></div>
  <div class="tile"><div class="l">Engaged visitors</div><div class="n">${st.engaged}</div><div class="s">10+ seconds on a page or 2+ pages</div></div>
  <div class="tile"><div class="l">Identified</div><div class="n">${st.identified}</div><div class="s">households</div></div>
  <div class="tile"><div class="l">Identified % of engaged</div><div class="n">${fmtPct(st.identifiedPct)}</div><div class="s">${st.identifiedEngaged} of ${st.engaged} engaged visitors</div></div>
  <div class="tile"><div class="l">Skipped on purpose</div><div class="n">${fmtPct(st.skippedPct)}</div>
    <div class="s">${st.topReasons.length ? st.topReasons.map((r, i) => html`${i ? html`<br>` : ''}${r.reason} (${r.n})`) : 'of all visitors'}</div></div>
  <div class="tile"><div class="l">Delivered</div><div class="n">${st.delivered}</div><div class="s">${st.leadsThisMonth} leads this month</div></div>
</div>`;

  if (ctx.print) {
    return shell(ctx, '/app', 'Results', html`
<h1 style="font-size:1.8rem">${ctx.site.name}: last 30 days</h1>
<p style="font-size:1.15rem">${st.identifiedPct === null ? 'No engaged visits yet.' : html`<strong>${st.identifiedPct}%</strong> of engaged visits identified. <strong>${st.leadsThisMonth}</strong> leads this month.`}</p>
${tiles}
<p class="small muted" style="margin-top:16px">Engaged = 10+ seconds on a page or 2+ pages. Identified % = engaged visitors we identified ÷ engaged visitors. Powered by ${ctx.app}.</p>`);
  }

  const rows = leads.map(({ lead: l, pages, delivery, hail }) => {
    const name = [l.first_name, l.last_name].filter(Boolean).join(' ') || '—';
    const addr = [l.address_line1, l.city, l.state, l.zip].filter(Boolean).join(', ');
    const tier = confidenceTier(l.confidence);
    const status = delivery?.status ?? 'pending';
    const statusLabel = status === 'skipped' ? 'not sent (over plan)' : status;
    return html`<tr>
  <td data-l="When">${when(l.created_at)}</td>
  <td data-l="Name"><strong>${name}</strong></td>
  <td data-l="Address">${dash(addr)}</td>
  <td data-l="Hail">${hailCell(hail, now)}</td>
  <td data-l="Phone">${dash(l.phone)}</td>
  <td data-l="Confidence"><span class="pill ${tier}">${tier}</span> <span class="small muted">${l.confidence === null ? '' : `${Math.round(l.confidence * 100)}%`}</span></td>
  <td data-l="Pages" class="small">${pages.join(', ') || '—'}</td>
  <td data-l="Sent"><span class="pill ${status === 'delivered' ? 'delivered' : status === 'failed' ? 'failed' : 'new'}">${statusLabel}</span></td>
  <td data-l=""><button class="btn sec sm" type="button" data-copy="${name}, ${addr}, ${l.phone ?? ''}">Copy</button></td>
</tr>`;
  });

  return shell(ctx, '/app', 'Leads', html`
${quotaBanner(ctx, st)}
${st.lastSeen === null ? html`<div class="banner warn print-hide">No visits yet. Install the pixel from the <a href="${dashUrl(ctx, '/app/install')}">Install tab</a>.</div>` : ''}
${tiles}
<div class="row" style="justify-content:space-between;margin:24px 0 8px">
  <h2 style="margin:0">Leads</h2>
  <span class="small">${sort === 'hail' ? html`<a href="${dashUrl(ctx, '/app')}">Newest first</a> · <strong>Most hail first</strong>` : html`<strong>Newest first</strong> · <a href="${dashUrl(ctx, '/app', { sort: 'hail' })}">Most hail first</a>`}
  · <a href="${dashUrl(ctx, '/app', { print: '1' })}">Clean view for screenshots</a></span>
</div>
<div class="tablecard"><table class="stack">
<thead><tr><th>When</th><th>Name</th><th>Address</th><th>Hail</th><th>Phone</th><th>Confidence</th><th>Pages</th><th>Sent</th><th></th></tr></thead>
<tbody>${rows.length ? rows : html`<tr><td colspan="9" class="muted">No leads yet. They show up here as visitors are identified.</td></tr>`}</tbody>
</table></div>
<p class="small muted" style="margin-top:12px">Showing the last ${leads.length} leads. Every lead is also sent to the places on the <a href="${dashUrl(ctx, '/app/delivery')}">Delivery tab</a>.</p>`);
}

export function installPage(ctx: DashCtx, lastSeen: number | null): Html {
  const tag = `<script async src="${ctx.baseUrl}/p/${ctx.site.siteKey}.js"></script>`;
  const seen = lastSeen !== null && Date.now() - lastSeen < 24 * 3600 * 1000;
  return shell(ctx, '/app/install', 'Install', html`
<h1 style="font-size:1.8rem">Install the pixel</h1>
<p>Paste this one line into your website, right before <code>&lt;/head&gt;</code>, on every page. WordPress: a plugin like "WPCode" has a box for it. Squarespace and Wix: "Code injection" or "Custom code".</p>
<pre id="snippet">${tag}</pre>
<div class="row"><button class="btn sm" type="button" data-copy="#snippet">Copy snippet</button>
<span class="row small"><span class="dot ${seen ? 'ok' : 'bad'}"></span>${seen ? 'Pixel seen in the last 24 hours' : 'No visits in the last 24 hours'}</span></div>
<p class="small muted" style="margin-top:8px">Allowed on: ${ctx.site.allowedDomains.join(', ') || 'no domains yet'}. Visits from other domains are ignored.</p>
<div class="card" style="margin-top:24px">
  <h2 style="font-size:1.1rem">Add this to your privacy policy</h2>
  <p class="small">Our terms ask for it, and it keeps you on the right side of the law.</p>
  <blockquote id="disclosure" class="small" style="margin:0 0 12px">${disclosureText(ctx.app, ctx.baseUrl)}</blockquote>
  <button class="btn sec sm" type="button" data-copy="#disclosure">Copy paragraph</button>
</div>
<style>.dot{display:inline-block;width:10px;height:10px;border-radius:50%}.dot.ok{background:var(--ok)}.dot.bad{background:var(--bad)}</style>`);
}

export function deliveryPage(ctx: DashCtx, note?: { ok: boolean; msg: string }): Html {
  const kinds: Array<[string, string]> = [['json', 'JSON (Zapier, Make, GoHighLevel inbound webhook)'], ['slack', 'Slack incoming webhook'], ['ghl', 'GoHighLevel contact fields']];
  return shell(ctx, '/app/delivery', 'Delivery', html`
<h1 style="font-size:1.8rem">Where your leads go</h1>
${note ? html`<div class="banner ${note.ok ? 'ok' : 'bad'}">${note.msg}</div>` : ''}
<form method="post" action="${dashUrl(ctx, '/app/delivery')}" class="card narrow">
  <label for="lead_email">Email each lead to</label>
  <input id="lead_email" name="lead_email" type="email" value="${ctx.site.leadEmail ?? ''}" placeholder="you@yourroofing.com" autocomplete="email">
  <label for="webhook_url">Also post each lead to a webhook (optional)</label>
  <input id="webhook_url" name="webhook_url" value="${ctx.site.webhookUrl ?? ''}" placeholder="https://hooks.zapier.com/..." inputmode="url">
  <label for="webhook_kind">Webhook format</label>
  <select id="webhook_kind" name="webhook_kind">${kinds.map(([k, label]) => html`<option value="${k}" ${(ctx.site.webhookKind ?? 'json') === k ? 'selected' : ''}>${label}</option>`)}</select>
  <div class="row" style="margin-top:16px">
    <button class="btn" type="submit" name="action" value="save">Save</button>
    <button class="btn sec" type="submit" name="action" value="test">Save and send a test lead</button>
  </div>
  <p class="small muted" style="margin:12px 0 0">Leave both empty and leads only show on this page.</p>
</form>`);
}

export function deniedPage(app: string): Html {
  return page({ title: `Not found — ${app}`, app, noindex: true, footer: 'app', body: html`<div class="narrow"><h1>Not found</h1><p>Check the link. It needs your dashboard key (<code>?key=…</code>) from your welcome email.</p></div>` });
}

/** The login page: /app with no key. The key is the dashboard link from the welcome email. */
export function loginPage(app: string): Html {
  return page({
    title: `Log in — ${app}`,
    app,
    noindex: true,
    footer: 'app',
    body: html`<div class="narrow"><h1>Log in</h1>
<p>Your dashboard link from the welcome email is your login. Open that link, or paste the key from it here.</p>
<form method="get" action="/app" class="card">
  <label for="key">Dashboard key</label>
  <input id="key" name="key" required autocomplete="off" placeholder="dk_…">
  <button class="btn" style="margin-top:14px" type="submit">Open my dashboard</button>
</form>
<p class="small muted" style="margin-top:16px">Lost the email? Reply to any lead card, or write to <a href="mailto:hello@tryyardsign.com">hello@tryyardsign.com</a>.</p>
</div>`,
  });
}

export { raw };
