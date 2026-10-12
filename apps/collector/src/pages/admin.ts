/**
 * The operator page (/admin): every site, every lead, is the system working. Read-only.
 * The owner only. The frame, the attention list, spend and the plain tables are drawn here; the
 * range switch, chart, funnel and breakdowns are drawn in the browser by admin-explore.ts.
 * Never renders a raw IP or the provider fields we do not use (income, net worth, married, children).
 */
import { html, raw } from 'hono/html';
import type { DeliveryRow } from '@yardsign/db';
import type { AdminStats, Attention, RecentLead, SiteSummary, SpendNow } from '../admin-stats';
import { DELIVR_RATES, SPEND_WARN_SHARE } from '../admin-stats';
import { ADMIN_JS, scriptJson } from './admin-explore';
import { confidenceTier } from './dashboard';
import { page, type Html } from './layout';

export interface AdminCtx {
  app: string;
  /** IDENTITY_PROVIDER as configured. "mock" means fake people; anything else is live and billed. */
  provider: string;
  buildSha: string;
}

export const ADMIN_CSS = `
.mode{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 14px;border-radius:var(--r);margin-bottom:18px;font-size:.9rem}
.mode b{font-size:1rem;letter-spacing:.06em}
.mode.mock{background:var(--info-bg);color:var(--ink)}
.mode.live{background:var(--bad);color:#fff}
.mode .build{margin-left:auto;opacity:.8;font-size:.8rem}
.sec{margin:28px 0 0;padding:0}
.sec>h2,.cardh h2{font-size:1.15rem;margin:0}
.cardh{display:flex;align-items:baseline;gap:8px 12px;flex-wrap:wrap;margin:0 0 12px}
.cardh .sub{color:var(--muted);font-size:.9rem}
.sec p.note,p.note{margin:10px 0 0;color:var(--muted)}
table.num td.n,table.num th.n,td.n,th.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.err{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.8rem;word-break:break-word}
tr.lead a{text-decoration:none;font-weight:700}
.nt{color:var(--muted);font-style:italic}
.sr-only{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.top2{display:grid;gap:16px}
@media(min-width:860px){.top2{grid-template-columns:minmax(0,1.6fr) minmax(0,1fr)}}
.att ul{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.att li{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border-radius:10px;font-weight:600;font-size:.95rem}
.att li.bad{background:var(--bad-bg);color:var(--bad)}
.att li.warn{background:var(--warn-bg);color:var(--warn)}
.att li .ic{flex:none;width:20px;height:20px;border-radius:50%;display:grid;place-items:center;font-size:.75rem;font-weight:800;color:#fff;margin-top:1px}
.att li.bad .ic{background:var(--bad)}
.att li.warn .ic{background:var(--warn)}
.att li a{margin-left:auto;white-space:nowrap;color:inherit;font-size:.85rem}
.att .clear{display:flex;gap:10px;align-items:center;margin:0;padding:10px 12px;border-radius:10px;background:var(--ok-bg);color:var(--ok);font-weight:600}
.att .clear .ic{width:20px;height:20px;border-radius:50%;background:var(--ok);color:#fff;display:grid;place-items:center;font-size:.75rem}
.meter-row{margin:0 0 14px}
.meter-row .lbl{display:flex;justify-content:space-between;gap:8px;font-size:.9rem;margin-bottom:6px}
.meter-row .lbl b{font-size:1.05rem}
.bullet{height:10px;border-radius:999px;background:#e8eef8;overflow:hidden}
.bullet span{display:block;height:100%;border-radius:999px;background:#3987e5}
.bullet.warn span{background:#c98500}
.bullet.bad span{background:var(--bad)}
.ctl{position:sticky;top:0;z-index:5;display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;background:var(--bg);padding:12px 0;margin:22px 0 4px;border-bottom:1px solid var(--line)}
.seg{display:inline-flex;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:3px}
.seg button{font:inherit;font-size:.9rem;font-weight:600;border:0;background:none;color:var(--muted);padding:6px 12px;border-radius:7px;cursor:pointer}
.seg button[aria-pressed=true]{background:var(--ink);color:#fff}
#x-chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{font:inherit;font-size:.85rem;font-weight:600;border:1px solid #f3c7a6;background:#fff4ec;color:#8a3a00;border-radius:999px;padding:4px 10px;cursor:pointer}
.chip.clear{background:var(--card);border-color:var(--line);color:var(--muted)}
.ctl .tz{margin-left:auto;color:var(--muted);font-size:.8rem}
#explore.filtered .ctl{border-bottom-color:#f3c7a6}
.kpis{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));margin-top:14px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:14px 16px}
.kpi .kl{font-size:.85rem;color:var(--muted);font-weight:600}
.kpi .kv{font-size:2rem;font-weight:800;line-height:1.15;margin:2px 0}
.kpi .kv.accent{color:var(--brand)}
.kpi .kv.thin{color:var(--muted)}
.kpi .ks{font-size:.875rem}
.kpi .kd{font-size:.8rem;color:var(--muted);margin-top:4px}
.kpi .kd.up{color:var(--ok)}
.kpi .kd.down{color:var(--bad)}
.panel{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:16px;margin-top:16px}
.x-legend{display:flex;flex-wrap:wrap;gap:4px 6px;margin:0 0 8px}
.lg{font:inherit;font-size:.8rem;display:inline-flex;align-items:center;gap:6px;border:1px solid transparent;background:none;color:var(--ink);padding:3px 8px;border-radius:999px;cursor:pointer}
.lg:hover{border-color:var(--line)}
.lg i{width:10px;height:10px;border-radius:3px;display:inline-block}
.lg[aria-pressed=false]{color:var(--muted);text-decoration:line-through}
.lg[aria-pressed=false] i{opacity:.25}
#x-plot{position:relative;height:240px;overflow:hidden}
.x-svg{display:block}
.x-svg .grid{stroke:#eceae4;stroke-width:1}
.x-svg .base{stroke:#c3c2b7;stroke-width:1}
.x-svg .tick{fill:#6b6a65;font-size:11px;font-variant-numeric:tabular-nums}
.x-svg .total{fill:var(--ink);font-size:11px;font-weight:700;font-variant-numeric:tabular-nums}
.x-svg .empty{fill:var(--muted);font-size:14px}
.x-svg .wash{fill:transparent}
.x-svg .wash.hov{fill:#f1f4f9}
.x-svg .wash.sel{fill:#fde9da}
.x-svg .bar.dim{opacity:.3}
@media(prefers-reduced-motion:no-preference){.x-svg .bar{transition:opacity .15s}}
.x-hits{position:absolute;display:flex}
.x-hits .hit{flex:1;min-width:0;border:0;background:transparent;padding:0;margin:0;cursor:pointer;border-radius:4px}
.x-hits .hit:focus-visible{outline:2px solid var(--ink);outline-offset:-2px}
.x-tip{position:fixed;z-index:50;display:none;pointer-events:none;background:#fff;border:1px solid var(--line);border-radius:10px;box-shadow:0 8px 24px rgba(20,33,61,.14);padding:10px 12px;font-size:.82rem;min-width:200px;max-width:280px}
.x-tip .tt{font-weight:700;margin-bottom:6px}
.x-tip .tr{display:flex;align-items:center;gap:6px;line-height:1.6}
.x-tip .tr i{width:12px;height:3px;border-radius:2px;display:inline-block}
.x-tip .tr.total{margin-bottom:4px}
.x-tip .th{color:var(--muted);margin-top:6px;font-size:.75rem}
.g2x{display:grid;gap:16px}
@media(min-width:860px){.g2x{grid-template-columns:minmax(0,1.5fr) minmax(0,1fr)}}
.g2x .panel{margin-top:16px}
ol.fun{list-style:none;margin:0;padding:0;display:grid;gap:12px}
.fun li{display:grid;grid-template-columns:1fr;gap:4px}
.fun .fl{font-weight:600;font-size:.92rem}
.fun .ft{height:14px;background:#f1f3f7;border-radius:4px;overflow:hidden}
.fun .ft span{display:block;height:100%;background:#3987e5;border-radius:0 4px 4px 0}
.fun .ft span.lead{background:var(--brand)}
.fun .fn{font-variant-numeric:tabular-nums;display:flex;flex-wrap:wrap;gap:4px 8px;align-items:baseline}
.drop{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--bad);background:var(--bad-bg);padding:1px 8px;border-radius:999px}
ul.fam{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.fam .row{font:inherit;width:100%;text-align:left;display:grid;grid-template-columns:1fr;gap:4px;border:1px solid transparent;background:none;border-radius:10px;padding:8px 10px;cursor:pointer;color:var(--ink)}
.fam .row:hover{border-color:var(--line)}
.fam .row.on{border-color:#f3c7a6;background:#fff4ec}
.fam .nm{font-weight:600;font-size:.92rem}
.fam .meter{height:8px;border-radius:999px;background:#e8eef8;overflow:hidden}
.fam .meter span{display:block;height:100%;background:#184f95;border-radius:999px}
#x-tabs{display:flex;flex-wrap:wrap;gap:4px;margin:0 0 10px}
.tab{font:inherit;font-size:.85rem;font-weight:600;border:1px solid var(--line);background:var(--card);color:var(--muted);padding:5px 12px;border-radius:999px;cursor:pointer}
.tab[aria-pressed=true]{background:var(--ink);border-color:var(--ink);color:#fff}
.tablecard.scroll{overflow-x:auto}
.x-table{min-width:640px}
.x-table th{white-space:nowrap}
.x-table td.zero{color:#a3a29c}
.x-table td.nowrap{white-space:nowrap}
.x-table .nmcell{min-width:180px}
.pbar{display:block;height:3px;background:#f1f3f7;border-radius:2px;margin-top:5px;max-width:220px}
.pbar span{display:block;height:100%;background:#9ec5f4;border-radius:2px}
th button{font:inherit;font-size:inherit;letter-spacing:inherit;text-transform:inherit;color:inherit;font-weight:700;background:none;border:0;padding:0;cursor:pointer;display:inline-flex;gap:4px;align-items:center}
th button .arr{font-size:.7rem;opacity:.45}
th[aria-sort] button .arr{opacity:1;color:var(--ink)}
.link{font:inherit;background:none;border:0;padding:0;color:var(--ink);text-decoration:underline;text-decoration-color:#c8ccd6;text-underline-offset:3px;cursor:pointer;text-align:left}
.link:hover{text-decoration-color:var(--ink)}
.link.on{font-weight:700;text-decoration-color:var(--brand)}
.link.tag{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.82rem;color:var(--muted)}
.below{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;justify-content:space-between;margin-top:10px}
.empty-note{margin:8px 0}
.noscript{margin-top:16px}
details.how{margin-top:32px;border:1px solid var(--line);border-radius:var(--r);background:var(--card);padding:12px 16px}
details.how summary{font-weight:700}
details.how ul{margin:10px 0 0;padding-left:20px;color:var(--muted);font-size:.9rem}
details.how li{margin:4px 0}
#explore:not(.ready) .needs-js{opacity:.4}
@media(max-width:759px){
  table.num th,table.num td{padding:8px 6px;font-size:.85rem}
  table.stack td.n{white-space:normal;text-align:right}
  .ctl .tz{margin-left:0;width:100%}
  .kpi .kv{font-size:1.7rem}
}
`;

const when = (ms: number | null | undefined): Html => (ms ? html`<time datetime="${new Date(ms).toISOString()}">${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC</time>` : html`<span class="muted">never</span>`);
const ago = (ms: number | null, now: number): string => {
  if (!ms) return 'never';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};
const usd = (n: number): string => `$${n.toFixed(2)}`;
const cents = (c: number): string => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const notTracked = html`<span class="nt">not tracked yet</span>`;

/** A sortable header cell for the server-drawn tables. `n` marks a number column (right-aligned, sorts high to low first). */
const sth = (label: string, n = false) => html`<th scope="col"${n ? raw(' class="n"') : ''}><button type="button">${label}<span class="arr" aria-hidden="true">↕</span></button></th>`;

function shell(ctx: AdminCtx, title: string, body: Html): Html {
  const live = ctx.provider !== 'mock';
  return page({
    title: `${title} — ${ctx.app} admin`,
    app: ctx.app,
    nav: html`<nav><a href="/admin" class="on">Admin</a><a href="/app?key=">Customer view</a></nav>`,
    noindex: true,
    footer: 'app',
    head: `<style>${ADMIN_CSS}</style>`,
    body: html`<div class="mode ${live ? 'live' : 'mock'}"><b>${live ? 'LIVE' : 'MOCK'}</b><span>${live ? `Identity provider is "${ctx.provider}". Real people, real charges.` : 'Identity provider is "mock". Every lead is a made-up person. Nothing is billed.'}</span><span class="build">Build ${ctx.buildSha}</span></div>${body}`,
  });
}

function attention(list: Attention[]): Html {
  if (!list.length) return html`<p class="clear"><span class="ic" aria-hidden="true">✓</span>All clear. Nothing needs you right now.</p>`;
  return html`<ul>${list.map((a) => html`<li class="${a.level}"><span class="ic" aria-hidden="true">!</span><span><span class="sr-only">${a.level === 'bad' ? 'Problem: ' : 'Heads up: '}</span>${a.text}</span><a href="${a.href}">See it</a></li>`)}</ul>`;
}

function spendMeter(label: string, used: number, cap: number): Html {
  const share = cap ? used / cap : 0;
  const level = share >= 1 ? 'bad' : share >= SPEND_WARN_SHARE ? 'warn' : '';
  return html`<div class="meter-row"><div class="lbl"><span>${label}</span><span><b>${cents(used)}</b> <span class="muted">of ${cents(cap)}</span></span></div>
<div class="bullet ${level}" role="img" aria-label="${label}: ${cents(used)} of ${cents(cap)}, ${Math.round(share * 100)} percent"><span style="width:${Math.min(100, share * 100).toFixed(1)}%"></span></div></div>`;
}

function spendBox(sp: SpendNow): Html {
  return html`${spendMeter('Today', sp.dayCents, sp.dayCapCents)}${spendMeter('This month', sp.monthCents, sp.monthCapCents)}
<p class="small muted" style="margin:0">Counted the way the cap counts it (about 3 cents a match; no-matches are free). Days and months reset at midnight UTC, which is 7 PM Central (6 PM in winter). Delivr's own invoice is the truth.</p>`;
}

function explore(): Html {
  return html`<div id="explore">
<div class="ctl">
  <div class="seg" id="x-ranges" role="group" aria-label="Time range"><button type="button" data-range="24h" aria-pressed="false">24 hours</button><button type="button" data-range="7d" aria-pressed="true">7 days</button><button type="button" data-range="30d" aria-pressed="false">30 days</button></div>
  <div id="x-chips" aria-live="polite"></div>
  <span class="tz">Real lookups only (Delivr). Central time.</span>
</div>
<noscript><div class="banner warn noscript">The charts on this page need JavaScript.</div></noscript>
<div class="kpis needs-js" id="x-kpis"></div>
<section class="panel needs-js" id="chart">
  <div class="cardh"><h2>What happened to each visitor</h2><span class="sub x-win">Last 7 days</span></div>
  <p class="small muted" style="margin:-6px 0 10px" id="x-unit"></p>
  <div class="x-legend" id="x-legend" aria-label="Show or hide a group"></div>
  <div id="x-plot"></div>
  <div id="x-sr"></div><p class="sr-only" id="x-status" aria-live="polite"></p>
</section>
<div class="g2x">
  <section class="panel needs-js" id="funnel"><div class="cardh"><h2>Match funnel</h2><span class="sub">people, <span class="x-win">Last 7 days</span></span></div><div id="x-funnel"></div></section>
  <section class="panel needs-js" id="browsers"><div class="cardh"><h2>Match rate by browser</h2><span class="sub">click one to filter</span></div><div id="x-browsers"></div>
  <p class="small note"><strong>Safari and iPhone almost never match (Delivr says under 1%).</strong> That is expected, not a problem. Every iPhone browser counts as Safari, because Apple makes them all run on Safari.</p></section>
</div>
<section class="panel needs-js" id="breakdown"><div class="cardh"><h2>Where they came from</h2><span class="sub x-win">Last 7 days</span></div><div id="x-tabs" role="group" aria-label="Break down by"></div><div id="x-breakdown"></div></section>
<section class="sec needs-js" id="visits"><div class="cardh"><h2>Visits</h2><span class="sub x-win">Last 7 days</span></div><div id="x-visits"></div></section>
</div>`;
}

function delivery(st: AdminStats): Html {
  const rows = st.channels.filter((c) => c.delivered || c.failed || c.skipped || ['email', 'webhook:slack', 'webhook:ghl', 'webhook:json'].includes(c.channel));
  return html`<div class="tablecard"><table class="num sortable">
<thead><tr>${sth('Channel')}${sth('Sent', true)}${sth('Failed', true)}${sth('Skipped', true)}</tr></thead>
<tbody>${rows.map((c) => html`<tr><td>${c.label}</td><td class="n">${c.delivered}</td><td class="n ${c.failed ? 'pill failed' : ''}">${c.failed}</td><td class="n">${c.skipped}</td></tr>`)}</tbody>
</table></div>
<p class="small muted note">Skipped means the account was over its monthly plan; the lead is saved, not sent.</p>
<h3 style="font-size:1rem;margin:16px 0 8px">Recent failures</h3>
${st.failures.length
  ? html`<div class="tablecard"><table class="stack">
<thead><tr><th>When</th><th>Site</th><th>Channel</th><th>Error</th></tr></thead>
<tbody>${st.failures.map((f) => html`<tr><td data-l="When">${when(f.at)}</td><td data-l="Site">${f.siteName}</td><td data-l="Channel">${f.channel}</td><td data-l="Error" class="err">${f.error || '—'}</td></tr>`)}</tbody></table></div>`
  : html`<p class="muted">No failed deliveries in the last 7 days.</p>`}`;
}

function sites(list: SiteSummary[], now: number): Html {
  return html`<div class="tablecard"><table class="stack num sortable">
<thead><tr>${sth('Site')}${sth('Owner')}${sth('Install seen', true)}${sth('Visits 30d', true)}${sth('Leads 30d', true)}${sth('Spend 30d', true)}${sth('Delivery')}</tr></thead>
<tbody>${list.map(
  (s) => html`<tr>
  <td data-l="Site" data-sort="${s.name}"><div><strong>${s.name}</strong> ${s.active ? '' : html`<span class="pill bad">off</span> `}${s.delivr ? html`<span class="pill ok">Delivr</span>` : html`<span class="pill new">mock</span>`}<br><span class="small muted">${s.siteKey}</span></div></td>
  <td data-l="Owner" class="small">${s.ownerEmail}</td>
  <td data-l="Install seen" class="n" data-sort="${s.installSeenAt ?? 0}"><span class="pill ${s.installSeenAt && now - s.installSeenAt < 86_400_000 ? 'ok' : 'bad'}">${ago(s.installSeenAt, now)}</span></td>
  <td data-l="Visits 30d" class="n">${s.visits30}</td>
  <td data-l="Leads 30d" class="n" data-sort="${s.leads30}"><span>${s.leads30} <span class="small muted">of ${s.sent30} asked</span></span></td>
  <td data-l="Spend 30d" class="n" data-sort="${s.spend30Usd}"><span>${usd(s.spend30Usd)} <span class="small muted">est.</span></span></td>
  <td data-l="Delivery" class="small">${s.channels.length ? s.channels.join(', ') : html`<span class="muted">log only</span>`}</td>
</tr>`,
)}</tbody></table></div>
<p class="small muted note">Install seen is the last time the site's pixel script was fetched or a visit was stored, whichever is newer. Spend is an estimate: $${DELIVR_RATES.fullProfileUsdPer1000} per 1,000 rows returned plus $${DELIVR_RATES.webEventUsdPer1000} per 1,000 page views on sites with a Delivr pixel. Mock lookups cost nothing.</p>`;
}

function leads(list: RecentLead[]): Html {
  if (!list.length) return html`<p class="muted">No leads in the last 7 days.</p>`;
  return html`<div class="tablecard"><table class="stack sortable">
<thead><tr>${sth('When', true)}${sth('Site')}${sth('Name')}${sth('City')}${sth('Match score', true)}${sth('Delivery')}</tr></thead>
<tbody>${list.map((l) => {
  const tier = confidenceTier(l.confidence);
  const pill = l.status === 'delivered' ? 'delivered' : l.status === 'failed' ? 'failed' : 'new';
  return html`<tr class="lead">
  <td data-l="When" data-sort="${l.at}">${when(l.at)}</td>
  <td data-l="Site">${l.siteName}</td>
  <td data-l="Name"><a href="/admin/leads/${l.id}">${l.name}</a></td>
  <td data-l="City">${l.city}</td>
  <td data-l="Match score" data-sort="${l.confidence ?? -1}"><span><span class="pill ${tier}">${tier}</span> <span class="small muted">${l.confidence === null ? '' : `${Math.round(l.confidence * 100)}%`}</span></span></td>
  <td data-l="Delivery"><span class="pill ${pill}">${l.status === 'skipped' ? 'not sent (over plan)' : l.status}</span></td>
</tr>`;
})}</tbody></table></div>
<p class="small muted note">Last 7 days, newest first, up to 100. Tap a name for the same card the customer got. Click a column name to sort.</p>`;
}

function how(st: AdminStats): Html {
  return html`<details class="how"><summary>How these numbers are counted</summary><ul>
<li>"People" counts each browser once, however many pages it viewed. One person on a phone and a laptop counts twice.</li>
<li>The charts, funnel and visit list cover sites with a Delivr pixel. Lookups, matches and leads count Delivr only; mock is left out.</li>
<li>"Could be looked up" means at least one visit passed the privacy checks: in the US, no Global Privacy Control, not a known bot. People who could be looked up but were not asked were usually asked recently already, or are waiting for the next check (every 5 minutes; Delivr waits 10 minutes on purpose).</li>
<li>Match rate is people Delivr matched ÷ people we asked about. Below 20 people asked, the number is grey: too few to judge.</li>
<li>Each bar in the chart counts people in that hour or day. Someone who came on two days shows in both bars, so the bars add up to more than the "People" number.</li>
<li>"Matched, not sent" covers opt-outs and matches too unsure to send, including a repeat match for someone who is already a lead.</li>
<li>Visits from the EU, UK and Switzerland, and visits whose user agent says bot, are never stored, so they are not here. iPads on newer iPadOS report as a Mac and count as Desktop.</li>
<li>Data covers the last 60 days${st.explore.truncated ? html`, cut to the newest 20,000 page views` : ''}. Read-only: nothing on this page changes data.</li>
</ul></details>`;
}

export function adminPage(ctx: AdminCtx, st: AdminStats, now = Date.now()): Html {
  const section = (id: string, title: string, sub: string, body: Html) => html`<section class="sec" id="${id}"><div class="cardh"><h2>${title}</h2>${sub ? html`<span class="sub">${sub}</span>` : ''}</div>${body}</section>`;
  return shell(ctx, 'Admin', html`
<div class="top2">
  <section class="panel att" id="attention" style="margin-top:0"><div class="cardh"><h2>Needs attention</h2></div>${attention(st.attention)}</section>
  <section class="panel" id="spend" style="margin-top:0"><div class="cardh"><h2>Delivr spend</h2><span class="sub">caps stop lookups past these</span></div>${spendBox(st.spend)}</section>
</div>
${explore()}
${section('leads', 'Recent leads', 'last 7 days', leads(st.leads))}
${section('delivery', 'Delivery health', 'last 7 days', delivery(st))}
${section('sites', 'Sites', `${st.sites.length}`, sites(st.sites, now))}
${how(st)}
<p class="small muted" style="margin-top:20px">Generated ${when(now)}.</p>
<script type="application/json" id="explore-data">${raw(scriptJson(st.explore))}</script>
<script>${raw(ADMIN_JS)}</script>`);
}

/** The same fields the customer's lead card shows. Nothing from the provider's extras. */
export interface LeadDetail {
  siteName: string;
  name: string;
  address: string;
  phone: string | null;
  email: string | null;
  confidence: number | null;
  pages: string[];
  connection: string | null;
  seenAt: number;
  mock: boolean;
  deliveries: DeliveryRow[];
}

export function adminLeadPage(ctx: AdminCtx, d: LeadDetail): Html {
  const tier = confidenceTier(d.confidence);
  return shell(ctx, 'Lead', html`
<p><a href="/admin">← Back to admin</a></p>
${d.mock ? html`<div class="banner info">Mock person. This lead came from the mock provider; the details are made up.</div>` : ''}
<div class="card narrow">
  <div class="small muted" style="text-transform:uppercase;letter-spacing:.06em">Lead · ${d.siteName}</div>
  <h1 style="font-size:1.6rem;margin:4px 0">${d.name}</h1>
  <p class="muted">${d.address}</p>
  <dl class="rows">
    <dt>Phone</dt><dd>${d.phone ?? html`<span class="muted">not available</span>`}</dd>
    <dt>Email</dt><dd>${d.email ?? html`<span class="muted">not available</span>`}</dd>
    <dt>Confidence</dt><dd><span class="pill ${tier}">${tier}</span> ${d.confidence === null ? '' : `${Math.round(d.confidence * 100)}%`}</dd>
    <dt>Pages viewed</dt><dd>${d.pages.length ? d.pages.join(', ') : html`<span class="muted">not recorded</span>`}</dd>
    <dt>Connection</dt><dd>${d.connection ?? html`<span class="muted">unknown</span>`}</dd>
    <dt>Seen</dt><dd>${when(d.seenAt)}</dd>
  </dl>
</div>
<h2 style="font-size:1.1rem;margin:24px 0 8px">Deliveries</h2>
${d.deliveries.length
  ? html`<div class="tablecard"><table class="stack"><thead><tr><th>When</th><th>Channel</th><th>Status</th><th>Error</th></tr></thead>
<tbody>${d.deliveries.map((x) => html`<tr><td data-l="When">${when(x.created_at)}</td><td data-l="Channel">${x.channel}</td><td data-l="Status"><span class="pill ${x.status === 'delivered' ? 'delivered' : x.status === 'failed' ? 'failed' : 'new'}">${x.status}</span></td><td data-l="Error" class="err">${x.last_error ?? '—'}</td></tr>`)}</tbody></table></div>`
  : html`<p class="muted">No delivery rows.</p>`}`);
}

export function adminForbiddenPage(app: string): Html {
  return page({ title: `Forbidden — ${app}`, app, noindex: true, footer: 'app', body: html`<div class="narrow"><h1>Forbidden</h1><p>This page is for the operator and needs a valid Cloudflare Access login.</p></div>` });
}

export { raw, notTracked };
