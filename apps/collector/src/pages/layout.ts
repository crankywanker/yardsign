/** Shared HTML shell and the one stylesheet. Ported from the old app's pages/layout.ts. */
import { html, raw } from 'hono/html';
import { appFooter, siteFooter } from './footer';

export type Html = ReturnType<typeof html>;

export const CSS = `
:root{--ink:#14213d;--muted:#5c677d;--line:#e3e7ee;--bg:#f7f8fa;--card:#fff;--brand:#e85d04;--brand-ink:#fff;
--ok:#1b7f3b;--ok-bg:#e6f4ea;--warn:#8a5a00;--warn-bg:#fff4d6;--bad:#b42318;--bad-bg:#fde8e7;--info-bg:#eaf1fb;--r:12px}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--ink)}
h1,h2,h3{line-height:1.2;margin:0 0 .5em}
h1{font-size:clamp(2rem,6vw,3.2rem);letter-spacing:-.02em}
h2{font-size:1.5rem}
p{margin:0 0 1em}
.wrap{max-width:1040px;margin:0 auto;padding:0 16px}
.narrow{max-width:720px}
header.top{background:var(--card);border-bottom:1px solid var(--line)}
header.top .wrap{display:flex;align-items:center;gap:16px;min-height:56px;flex-wrap:wrap}
.logo{font-weight:800;text-decoration:none;font-size:1.15rem;display:flex;align-items:center;gap:8px}
.logo .sign{display:inline-block;width:22px;height:16px;background:var(--brand);border-radius:3px;position:relative}
.logo .sign:after{content:"";position:absolute;left:9px;top:16px;width:4px;height:8px;background:var(--ink)}
nav{display:flex;gap:4px;flex-wrap:wrap;margin-left:auto}
nav a{text-decoration:none;padding:6px 10px;border-radius:8px;color:var(--muted);font-weight:600;font-size:.95rem}
nav a.on,nav a:hover{background:var(--bg);color:var(--ink)}
main{padding:24px 0 48px}
section{padding:40px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:20px}
.grid{display:grid;gap:16px}
@media(min-width:760px){.g2{grid-template-columns:1fr 1fr}.g3{grid-template-columns:repeat(3,1fr)}}
.tiles{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-bottom:16px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:14px 16px}
.tile .l{font-size:.85rem;color:var(--muted);font-weight:600}
.tile .n{font-size:2rem;font-weight:800;line-height:1.15;margin:2px 0}
.tile .s{font-size:.8rem;color:var(--muted)}
.btn{display:inline-block;border:0;border-radius:10px;padding:12px 18px;font:inherit;font-weight:700;cursor:pointer;text-decoration:none;text-align:center;background:var(--brand);color:var(--brand-ink)}
.btn.sec{background:var(--card);color:var(--ink);border:1px solid var(--line)}
.btn.sm{padding:6px 10px;font-size:.85rem;border-radius:8px}
.btn:disabled{opacity:.5;cursor:default}
input,select{font:inherit;padding:11px 12px;border:1px solid var(--line);border-radius:10px;width:100%;background:#fff;color:var(--ink)}
label{display:block;font-weight:600;font-size:.9rem;margin:12px 0 4px}
.muted{color:var(--muted)}
.small{font-size:.875rem}
.pill{display:inline-block;padding:2px 10px;border-radius:999px;font-size:.8rem;font-weight:700;white-space:nowrap}
.pill.high,.pill.delivered,.pill.ok{background:var(--ok-bg);color:var(--ok)}
.pill.medium,.pill.new{background:var(--warn-bg);color:var(--warn)}
.pill.low,.pill.failed,.pill.bad{background:var(--bad-bg);color:var(--bad)}
.banner{border-radius:var(--r);padding:12px 16px;margin-bottom:16px;font-weight:600}
.banner.warn{background:var(--warn-bg);color:var(--warn)}
.banner.bad{background:var(--bad-bg);color:var(--bad)}
.banner.info{background:var(--info-bg)}
.banner.ok{background:var(--ok-bg);color:var(--ok)}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85rem}
pre{background:var(--ink);color:#fff;padding:14px;border-radius:10px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;margin:0 0 12px}
table{width:100%;border-collapse:collapse;background:var(--card)}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top;font-size:.92rem}
th{font-size:.78rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.tablecard{border:1px solid var(--line);border-radius:var(--r);overflow:hidden}
@media(max-width:759px){
  table.stack thead{display:none}
  table.stack tr{display:block;border-bottom:1px solid var(--line);padding:8px 4px}
  table.stack td{display:flex;justify-content:space-between;gap:12px;border:0;padding:4px 12px}
  table.stack td:before{content:attr(data-l);font-weight:700;color:var(--muted);font-size:.8rem}
}
dl.rows{display:grid;grid-template-columns:auto 1fr;gap:8px 16px;margin:0}
dl.rows dt{color:var(--muted);font-weight:600}
dl.rows dd{margin:0;font-weight:600}
footer.bottom{border-top:1px solid var(--line);padding:24px 0;color:var(--muted);font-size:.875rem}
footer.bottom a{color:var(--muted);margin-right:16px}
footer.site{--f-bg:#1F2430;--f-text:#EFE8DA;--f-link:#D8D1C3;--f-soft:#C9C2B4;--f-dim:#A9A397;--f-head:#F2B25A;--f-accent:#E9893D;--f-line:#3A4050;--f-btn-line:#5A6172;
background:var(--f-bg);color:var(--f-text);margin-top:24px;padding:40px 0 28px;font-family:"Source Sans 3",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:15px;line-height:1.5}
footer.site .fwrap{max-width:1216px;margin:0 auto;padding:0 20px;display:flex;flex-direction:column;gap:28px}
footer.site a{color:var(--f-link);text-decoration:none}
footer.site a:hover,footer.site a:focus-visible{color:var(--f-head)}
footer.site .ftop{display:flex;flex-direction:column;gap:28px}
footer.site .fbrand{display:flex;flex-direction:column;gap:12px}
footer.site .fbrand .flogo{display:flex;align-items:center;gap:10px;color:var(--f-text);min-height:44px;width:max-content}
footer.site .fbrand .flogo svg{width:30px;height:30px;flex:none}
footer.site .fbrand .flogo span{font-family:"Bricolage Grotesque",system-ui,sans-serif;font-weight:700;font-size:24px;line-height:1.1}
footer.site .fbrand p{margin:0;font-size:16px;color:var(--f-soft)}
footer.site .fbtns{display:flex;flex-direction:column;gap:12px}
footer.site .fbtns a{display:flex;align-items:center;justify-content:center;height:48px;padding:0 20px;border-radius:10px;font-weight:600;font-size:16px}
footer.site .fbtns a.primary{background:var(--f-accent);color:var(--f-bg)}
footer.site .fbtns a.primary:hover{color:var(--f-bg);background:var(--f-head)}
footer.site .fbtns a.secondary{border:1px solid var(--f-btn-line);color:var(--f-text)}
footer.site .fnav{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:20px;row-gap:28px;padding-top:24px;border-top:1px solid var(--f-line)}
footer.site .fcell{display:flex;flex-direction:column;gap:28px}
footer.site .fcol{display:flex;flex-direction:column;gap:10px}
footer.site .fcol h2{margin:0 0 2px;font-family:inherit;font-size:13px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--f-head);line-height:1.4}
footer.site .fcol a{display:block;padding:11px 0;margin:-6px 0}
footer.site .fcol p{margin:0;color:var(--f-soft)}
footer.site .fbottom{display:flex;flex-direction:column;gap:12px;padding-top:20px;border-top:1px solid var(--f-line);font-size:14px;color:var(--f-dim)}
footer.site .ftrust{margin:0;color:var(--f-soft)}
footer.site .frow{display:flex;flex-direction:column;gap:12px}
footer.site .flinks{display:flex;gap:20px;flex-wrap:wrap}
footer.site .flinks a{color:var(--f-dim);display:inline-flex;align-items:center;padding:12px 0;margin:-12px 0}
@media(min-width:760px){
  footer.site{padding:48px 0 32px}
  footer.site .fwrap{padding:0 40px;gap:32px}
  footer.site .ftop.inline{display:grid;grid-template-columns:repeat(var(--fcols),minmax(0,1fr));gap:40px}
  footer.site .ftop.inline .fnav{display:contents}
  footer.site .ftop.stacked{gap:40px}
  footer.site .ftop.stacked .fhead{display:flex;justify-content:space-between;align-items:flex-end;gap:48px;padding-bottom:32px;border-bottom:1px solid var(--f-line)}
  footer.site .ftop.stacked .fbrand{max-width:620px}
  footer.site .ftop.stacked .fbrand .flogo svg{width:34px;height:34px}
  footer.site .ftop.stacked .fbrand .flogo span{font-size:28px;letter-spacing:-.01em}
  footer.site .ftop.stacked .fbrand p{font-size:17px}
  footer.site .ftop.stacked .fnav{grid-template-columns:repeat(var(--fcols),minmax(0,1fr));gap:32px;padding-top:0;border-top:0}
  footer.site .fbtns{flex-direction:row;flex-shrink:0}
  footer.site .fbtns a{padding:0 22px}
  footer.site .fbtns a.primary{order:2}
  footer.site .fcell{gap:24px}
  footer.site .fcol{gap:12px}
  footer.site .fcol h2{margin:0 0 4px}
  footer.site .fcol a{padding:0;margin:0}
  footer.site .fbottom{gap:16px;padding-top:24px}
  footer.site .frow{flex-direction:row;justify-content:space-between;align-items:center}
  footer.site .flinks{gap:24px}
  footer.site .flinks a{padding:0;margin:0}
}
.hero{padding:48px 0 24px}
.hero p.lead{font-size:1.2rem;color:var(--muted);max-width:40em}
.example{position:relative}
.example:before{content:"Example";position:absolute;top:-10px;right:16px;background:var(--ink);color:#fff;font-size:.75rem;font-weight:700;padding:2px 10px;border-radius:999px}
.verdict{margin-top:14px;padding:12px 14px;border-radius:10px;font-weight:600}
.verdict.yes{background:var(--ok-bg);color:var(--ok)}
.verdict.no{background:var(--bad-bg);color:var(--bad)}
.price{font-size:2.4rem;font-weight:800}
.steps{counter-reset:s;list-style:none;padding:0;margin:0}
.steps li{counter-increment:s;padding-left:44px;position:relative;margin-bottom:16px}
.steps li:before{content:counter(s);position:absolute;left:0;top:0;width:30px;height:30px;border-radius:50%;background:var(--brand);color:#fff;font-weight:800;display:grid;place-items:center}
details{border-bottom:1px solid var(--line);padding:12px 0}
summary{font-weight:700;cursor:pointer}
.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.print-hide{}
body.print .print-hide{display:none!important}
@media print{.print-hide{display:none!important}}
`;

export interface PageOpts {
  title: string;
  app: string;
  nav?: Html | string;
  body: Html | string;
  /** Extra tags for <head>, e.g. the pixel on the founder's own pages. Trusted markup only. */
  head?: string;
  bodyClass?: string;
  noindex?: boolean;
  description?: string;
  /** Absolute clean https URL for <link rel="canonical">. Set on every public page. */
  canonical?: string;
  /**
   * Which footer. 'site' (the default) is the dark footer with every live public link; it goes on
   * every public page and the HTML 404. 'app' is the small one for the dashboard, the operator
   * page and the after-checkout page. The site footer never appears in the dashboard.
   */
  footer?: 'site' | 'app';
}

/**
 * A short fingerprint of the stylesheet, put in its URL so a deploy that changes the CSS is
 * never stuck behind the hour-long cache on /style.css (the edge and browsers both keep it).
 */
export const CSS_VERSION = (() => {
  let h = 2166136261;
  for (let i = 0; i < CSS.length; i++) h = Math.imul(h ^ CSS.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
})();

/** The footer's fonts (Bricolage Grotesque for the name, Source Sans 3 for the rest). Only on pages that show the site footer. */
const FOOTER_FONTS = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700&family=Source+Sans+3:wght@400;600&display=swap" rel="stylesheet">';

const FAVICON = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="3" y="4" width="26" height="17" rx="3" fill="#e85d04"/><rect x="14" y="21" width="4" height="9" fill="#14213d"/></svg>');

export function page(o: PageOpts): Html {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${o.title}</title>
${o.description ? html`<meta name="description" content="${o.description}">` : ''}
${o.noindex ? raw('<meta name="robots" content="noindex">') : ''}
${o.canonical ? html`<link rel="canonical" href="${o.canonical}">` : ''}
<link rel="stylesheet" href="/style.css?v=${CSS_VERSION}">
${o.footer === 'app' ? '' : raw(FOOTER_FONTS)}
<link rel="icon" href="data:image/svg+xml,${raw(FAVICON)}">
${o.head ? raw(o.head) : ''}
</head>
<body class="${o.bodyClass ?? ''}">
<header class="top print-hide"><div class="wrap">
<a class="logo" href="/"><span class="sign"></span>${o.app}</a>
${o.nav ?? ''}
</div></header>
<main><div class="wrap">${o.body}</div></main>
${o.footer === 'app' ? appFooter() : siteFooter(o.app)}
<script>
document.addEventListener('click',function(e){var b=e.target.closest('[data-copy]');if(!b)return;var v=b.getAttribute('data-copy');if(v.charAt(0)==='#'){var el=document.querySelector(v);v=el?el.textContent:''}
navigator.clipboard.writeText(v).then(function(){var o=b.textContent;b.textContent='Copied';setTimeout(function(){b.textContent=o},1200)})});
</script>
</body>
</html>`;
}
