/**
 * The interactive half of /admin: the range switch, the "what happened to each visitor" chart,
 * the funnel, the breakdown tables and the visit list. Plain ES2019, no library, no build step.
 * It reads the compact visit rows the server embeds (admin-stats.ts ExploreData) and redraws
 * everything in the browser when the range, a clicked bar or a clicked row changes.
 *
 * Every name and label from the data goes into the page with textContent, never innerHTML.
 * Times are Central (America/Chicago), where the operator is.
 *
 * Kept as a string so the Worker serves it inline. Do not use backticks or template
 * placeholders inside it.
 */
export const ADMIN_JS = String.raw`(function () {
  'use strict';
  var dataEl = document.getElementById('explore-data');
  if (!dataEl || !document.getElementById('x-plot')) return;
  var D = JSON.parse(dataEl.textContent);
  var R = D.rows, DI = D.dict, NOW = D.now;
  var T = 0, VIS = 1, SITE = 2, FAM = 3, DEV = 4, DLAB = 5, PATH = 6, PLACE = 7, NET = 8, FLAGS = 9, SKIP = 10, WHY = 11, OKIND = 12, OLAB = 13, CENTS = 14, LEAD = 15, SRC = 16;
  var E = 1, A = 2, M = 4, L = 8;
  var HOUR = 3600000, DAY = 86400000, TZ = 'America/Chicago';
  var FAMS = ['Chrome, Edge and Android', 'Safari (iPhone and Mac)', 'Other browsers'];
  var DEVS = ['iPhone / iPad', 'Android', 'Desktop', 'Other'];
  var OUTK = ['lead', 'waiting', 'no_match', 'skipped', 'error', 'checked'];
  var CATS = [
    { k: 'lead', label: 'Became a lead', color: '#e85d04' },
    { k: 'held', label: 'Matched, not sent', color: '#184f95' },
    { k: 'miss', label: 'Asked Delivr, no match', color: '#3987e5' },
    { k: 'wait', label: 'Could be looked up, not asked', color: '#9ec5f4' },
    { k: 'skip', label: 'Skipped on purpose', color: '#9a988f' }
  ];
  var DIMS = {
    src: { label: 'Source', col: SRC, list: DI.src },
    path: { label: 'Page', col: PATH, list: DI.path },
    place: { label: 'Where from', col: PLACE, list: DI.place },
    net: { label: 'Network', col: NET, list: DI.net },
    dev: { label: 'Device', col: DEV, list: DEVS },
    fam: { label: 'Browser', col: FAM, list: FAMS },
    skip: { label: 'Why skipped', col: SKIP, list: DI.skip, none: 'Not skipped' },
    site: { label: 'Site', col: SITE, list: DI.site },
    vis: { label: 'Visitor', col: VIS, list: DI.tag }
  };
  var TABS = ['src', 'path', 'place', 'net', 'dev', 'fam', 'skip'].concat(DI.site.length > 1 ? ['site'] : []);
  var RANGES = {
    '24h': { label: 'Last 24 hours', prior: 'the 24 hours before', unit: 'hour' },
    '7d': { label: 'Last 7 days', prior: 'the 7 days before', unit: 'day' },
    '30d': { label: 'Last 30 days', prior: 'the 30 days before', unit: 'day' }
  };
  var coll = new Intl.Collator('en-US', { numeric: true, sensitivity: 'base' });

  var st = { range: '7d', sel: null, f: [], hidden: {}, tab: 'src', bsort: { k: 'people', dir: -1 }, vsort: { k: 't', dir: -1 }, blimit: 15, vlimit: 25 };
  var chart = null, hoverI = -1, focusI = -1, refocus = null;

  // ---------- time, in Central ----------
  var pf = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
  function parts(t) {
    var o = {};
    pf.formatToParts(new Date(t)).forEach(function (p) { o[p.type] = p.value; });
    return { y: +o.year, m: +o.month, d: +o.day, h: (+o.hour) % 24, mi: +o.minute };
  }
  function offset(t) { var p = parts(t); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - Math.floor(t / 60000) * 60000; }
  function dayStart(t) { var p = parts(t); var g = Date.UTC(p.y, p.m - 1, p.d); return g - offset(g - offset(g)); }
  function fmt(o) { o.timeZone = TZ; var f = new Intl.DateTimeFormat('en-US', o); return function (t) { return f.format(new Date(t)); }; }
  var fDay = fmt({ month: 'short', day: 'numeric' });
  var fDayLong = fmt({ weekday: 'short', month: 'short', day: 'numeric' });
  var fHour = fmt({ hour: 'numeric' });
  var fWhen = fmt({ month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  function edgesFor(range) {
    var e = [], i;
    if (range === '24h') {
      var end = Math.floor(NOW / HOUR) * HOUR + HOUR;
      for (i = 24; i >= 0; i--) e.push(end - i * HOUR);
      return e;
    }
    var n = range === '30d' ? 30 : 7, today = dayStart(NOW);
    for (i = n - 1; i > 0; i--) e.push(dayStart(today - i * DAY + 12 * HOUR));
    e.push(today, dayStart(today + DAY + 12 * HOUR));
    return e;
  }
  function bucketOf(t, e) {
    if (t < e[0] || t >= e[e.length - 1]) return -1;
    var lo = 0, hi = e.length - 1;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (e[mid] <= t) lo = mid; else hi = mid; }
    return lo;
  }
  function bucketLabel(i, e, long) {
    if (RANGES[st.range].unit === 'hour') return (long ? fDayLong(e[i]) + ', ' : '') + fHour(e[i]) + (long ? ' to ' + fHour(e[i + 1]) : '');
    return long ? fDayLong(e[i]) : fDay(e[i]);
  }

  // ---------- numbers ----------
  function fmtN(n) { return n.toLocaleString('en-US'); }
  function money(c) { return '$' + (c / 100).toFixed(2); }
  function pctOf(a, b) { return b ? Math.round((a / b) * 100) + '%' : '—'; }
  function norm(f) { if (f & L) f |= M; if (f & M) f |= A; if (f & A) f |= E; return f; }
  function cat(f) { return f & L ? 0 : f & M ? 1 : f & A ? 2 : f & E ? 3 : 4; }
  function lowerBound(t) { var lo = 0, hi = R.length; while (lo < hi) { var mid = (lo + hi) >> 1; if (R[mid][T] < t) lo = mid + 1; else hi = mid; } return lo; }
  function pass(r) { for (var i = 0; i < st.f.length; i++) { var f = st.f[i]; if (r[DIMS[f.k].col] !== f.v) return false; } return true; }
  function scan(a, b, fn) { for (var i = lowerBound(a); i < R.length && R[i][T] < b; i++) if (pass(R[i])) fn(R[i]); }

  /** Count people (browsers), not page views, between a and b. */
  function people(a, b) {
    var by = {}, o = { people: 0, views: 0, e: 0, a: 0, m: 0, l: 0, cents: 0, fam: [[0, 0], [0, 0], [0, 0]], why: {} };
    scan(a, b, function (r) {
      o.views++;
      o.cents += r[CENTS];
      var p = by[r[VIS]];
      if (!p) { p = by[r[VIS]] = { f: 0, fam: r[FAM], why: -1 }; o.people++; }
      p.f |= r[FLAGS];
      p.fam = r[FAM];
      if (r[WHY] >= 0) p.why = r[WHY];
    });
    Object.keys(by).forEach(function (k) {
      var p = by[k], f = norm(p.f);
      if (f & E) o.e++;
      if (f & A) { o.a++; o.fam[p.fam][0]++; }
      if (f & M) { o.m++; o.fam[p.fam][1]++; }
      if (f & L) o.l++;
      else if ((f & M) && p.why >= 0) o.why[p.why] = (o.why[p.why] || 0) + 1;
    });
    return o;
  }

  function chartData(e) {
    var n = e.length - 1, maps = [], i;
    for (i = 0; i < n; i++) maps.push({});
    scan(e[0], e[n], function (r) { var b = bucketOf(r[T], e); if (b >= 0) maps[b][r[VIS]] = (maps[b][r[VIS]] || 0) | r[FLAGS]; });
    return maps.map(function (m) { var c = [0, 0, 0, 0, 0]; Object.keys(m).forEach(function (k) { c[cat(norm(m[k]))]++; }); return c; });
  }

  function breakdown(a, b, key) {
    var d = DIMS[key], groups = {};
    scan(a, b, function (r) {
      var g = r[d.col], G = groups[g];
      if (!G) G = groups[g] = { v: g, by: {}, views: 0 };
      G.views++;
      G.by[r[VIS]] = (G.by[r[VIS]] || 0) | r[FLAGS];
    });
    return Object.keys(groups).map(function (g) {
      var G = groups[g], o = { v: G.v, name: G.v < 0 ? d.none || 'None' : String(d.list[G.v]), views: G.views, people: 0, e: 0, a: 0, m: 0, l: 0 };
      Object.keys(G.by).forEach(function (k) { var f = norm(G.by[k]); o.people++; if (f & E) o.e++; if (f & A) o.a++; if (f & M) o.m++; if (f & L) o.l++; });
      o.rate = o.a ? o.m / o.a : -1;
      return o;
    });
  }

  // ---------- DOM helpers ----------
  function h(tag, attrs, kids) {
    var el = document.createElement(tag), k;
    if (attrs) for (k in attrs) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'text') el.textContent = v;
      else if (k === 'class') el.className = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    (kids || []).forEach(function (c) { if (c !== null && c !== undefined && c !== false) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }
  function svg(tag, attrs, text) {
    var el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (var k in attrs) el.setAttribute(k, attrs[k]);
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function put(id, kids) { var el = document.getElementById(id); if (!el) return null; el.textContent = ''; kids.forEach(function (c) { if (c) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }); return el; }

  function hasFilter(k, v) { return st.f.some(function (f) { return f.k === k && f.v === v; }); }
  function toggleFilter(k, v) {
    if (hasFilter(k, v)) st.f = st.f.filter(function (f) { return !(f.k === k && f.v === v); });
    else { st.f = st.f.filter(function (f) { return f.k !== k; }); st.f.push({ k: k, v: v }); }
    st.vlimit = 25;
    render();
  }
  function filterName(f) { var d = DIMS[f.k]; return f.v < 0 ? d.none || 'None' : String(d.list[f.v]); }

  /** A sortable table drawn from row objects. Sort state lives in "sort" so it survives redraws. */
  function dynTable(id, cols, rows, sort, limit, cell, rerender) {
    var col = cols.filter(function (c) { return c.k === sort.k; })[0] || cols[0];
    var sv = function (row, c) { return c.sv ? c.sv(row) : row[c.k]; };
    rows.sort(function (x, y) {
      var a = sv(x, col), b = sv(y, col);
      var c = typeof a === 'string' ? coll.compare(a, b) : a - b;
      if (!c && col !== cols[0]) { a = sv(x, cols[0]); b = sv(y, cols[0]); c = typeof a === 'string' ? coll.compare(a, b) : b - a; return c; }
      return c * sort.dir;
    });
    var head = h('tr', null, cols.map(function (c) {
      var on = c.k === col.k;
      var btn = h('button', {
        type: 'button', 'data-k': c.k,
        onclick: function () {
          if (on) sort.dir = -sort.dir; else { sort.k = c.k; sort.dir = c.text ? 1 : -1; }
          refocus = { table: id, k: c.k };
          rerender();
        }
      }, [c.label, h('span', { class: 'arr', 'aria-hidden': 'true', text: on ? (sort.dir > 0 ? '▲' : '▼') : '↕' })]);
      return h('th', { scope: 'col', class: c.text ? null : 'n', 'aria-sort': on ? (sort.dir > 0 ? 'ascending' : 'descending') : null }, [btn]);
    }));
    var body = h('tbody', null, rows.slice(0, limit).map(function (row) {
      return h('tr', null, cols.map(function (c) { var td = cell(row, c); if (!c.text) td.className = (td.className ? td.className + ' ' : '') + 'n'; return td; }));
    }));
    var t = h('table', { class: 'x-table', id: id }, [h('thead', null, [head]), body]);
    return t;
  }
  function restoreFocus() {
    if (!refocus) return;
    var b = document.querySelector('#' + refocus.table + ' th button[data-k="' + refocus.k + '"]');
    if (b) b.focus();
    refocus = null;
  }

  // ---------- chart ----------
  function nice(x, round) {
    var e = Math.floor(Math.log(x) / Math.LN10), f = x / Math.pow(10, e);
    var n = round ? (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) : (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10);
    return n * Math.pow(10, e);
  }
  function ticks(max) {
    if (max <= 0) return [0, 1];
    var s = Math.max(1, nice(nice(max, false) / 4, true)), t = [];
    for (var v = 0; v < max + s; v += s) t.push(v);
    return t;
  }
  function roundTop(x, y, w, hh, r) {
    r = Math.min(r, w / 2, hh);
    return 'M' + x + ',' + (y + hh) + 'V' + (y + r) + 'Q' + x + ',' + y + ' ' + (x + r) + ',' + y + 'H' + (x + w - r) + 'Q' + (x + w) + ',' + y + ' ' + (x + w) + ',' + (y + r) + 'V' + (y + hh) + 'Z';
  }

  function drawChart() {
    var box = document.getElementById('x-plot');
    var W = Math.max(280, Math.floor(box.clientWidth)), H = 240;
    var data = chart.data, e = chart.edges, n = data.length;
    var padL = 34, padR = 6, padT = n <= 14 ? 22 : 10, padB = 26, pw = W - padL - padR, ph = H - padT - padB;
    var totals = data.map(function (c) { var s = 0; for (var i = 0; i < 5; i++) if (!st.hidden[CATS[i].k]) s += c[i]; return s; });
    var max = Math.max.apply(null, totals.concat([0]));
    var tk = ticks(max), top = tk[tk.length - 1];
    var s = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, 'aria-hidden': 'true', class: 'x-svg' });
    tk.forEach(function (v) {
      var y = Math.round(padT + ph - (v / top) * ph) + 0.5;
      s.appendChild(svg('line', { x1: padL, x2: W - padR, y1: y, y2: y, class: v ? 'grid' : 'base' }));
      s.appendChild(svg('text', { x: padL - 6, y: y + 4, class: 'tick', 'text-anchor': 'end' }, fmtN(v)));
    });
    var band = pw / n, bw = Math.max(3, Math.min(24, band * 0.66));
    var maxL = Math.max(1, Math.floor(pw / 56)), step = Math.ceil(n / maxL);
    for (var i = 0; i < n; i++) {
      var x0 = padL + i * band;
      s.appendChild(svg('rect', { x: x0, y: padT, width: band, height: ph, class: 'wash' + (i === st.sel ? ' sel' : '') + (i === hoverI ? ' hov' : '') }));
      var g = svg('g', { class: 'bar' + (st.sel !== null && st.sel !== i ? ' dim' : '') });
      var x = x0 + (band - bw) / 2, y = padT + ph, segs = [];
      for (var k = 0; k < 5; k++) if (!st.hidden[CATS[k].k] && data[i][k]) segs.push(k);
      segs.forEach(function (k2, j) {
        var hh = (data[i][k2] / top) * ph, y1 = y - hh, y2 = j ? y - 2 : y;
        if (y2 - y1 < 1.5) y2 = y1 + 1.5;
        if (j === segs.length - 1) g.appendChild(svg('path', { d: roundTop(x, y1, bw, y2 - y1, 4), fill: CATS[k2].color }));
        else g.appendChild(svg('rect', { x: x, y: y1, width: bw, height: y2 - y1, fill: CATS[k2].color }));
        y = y1;
      });
      s.appendChild(g);
      if (n <= 14 && totals[i]) s.appendChild(svg('text', { x: x0 + band / 2, y: y - 6, class: 'total', 'text-anchor': 'middle' }, fmtN(totals[i])));
      if ((n - 1 - i) % step === 0) s.appendChild(svg('text', { x: x0 + band / 2, y: H - 8, class: 'tick', 'text-anchor': 'middle' }, bucketLabel(i, e, false)));
    }
    if (!max) s.appendChild(svg('text', { x: padL + pw / 2, y: padT + ph / 2, class: 'empty', 'text-anchor': 'middle' }, 'No visitors in this range'));

    var hits = h('div', { class: 'x-hits', role: 'group', 'aria-label': 'Bars. Pick one to see just that ' + RANGES[st.range].unit + '. Arrow keys move.', style: 'left:' + padL + 'px;top:' + padT + 'px;width:' + pw + 'px;height:' + ph + 'px' });
    var cur = focusI >= 0 && focusI < n ? focusI : st.sel !== null ? st.sel : n - 1;
    for (var j = 0; j < n; j++) hits.appendChild(hitButton(j, cur, data[j], e));
    box.textContent = '';
    box.appendChild(s);
    box.appendChild(hits);
  }

  function hitButton(i, cur, c, e) {
    var total = c[0] + c[1] + c[2] + c[3] + c[4];
    var label = bucketLabel(i, e, true) + ': ' + total + ' people, ' + c[0] + ' became leads, ' + c[1] + ' matched not sent, ' + c[2] + ' no match, ' + c[3] + ' not asked, ' + c[4] + ' skipped.';
    var b = h('button', { type: 'button', class: 'hit', tabindex: i === cur ? '0' : '-1', 'aria-pressed': st.sel === i ? 'true' : 'false', 'aria-label': label });
    b.addEventListener('click', function () { st.sel = st.sel === i ? null : i; focusI = i; refocus = { chart: i }; st.vlimit = 25; render(); });
    b.addEventListener('keydown', function (ev) {
      var n = chart.data.length, to = -1;
      if (ev.key === 'ArrowRight') to = Math.min(n - 1, i + 1);
      else if (ev.key === 'ArrowLeft') to = Math.max(0, i - 1);
      else if (ev.key === 'Home') to = 0;
      else if (ev.key === 'End') to = n - 1;
      else if (ev.key === 'Escape' && st.sel !== null) { st.sel = null; refocus = { chart: i }; render(); ev.preventDefault(); return; }
      if (to < 0) return;
      ev.preventDefault();
      var all = b.parentNode.children;
      b.setAttribute('tabindex', '-1');
      all[to].setAttribute('tabindex', '0');
      focusI = to;
      all[to].focus();
    });
    b.addEventListener('pointerenter', function (ev) { if (ev.pointerType !== 'touch') { setHover(i); showTip(i, b); } });
    b.addEventListener('pointerleave', function () { setHover(-1); hideTip(); });
    b.addEventListener('focus', function () { focusI = i; setHover(i); showTip(i, b); });
    b.addEventListener('blur', function () { setHover(-1); hideTip(); });
    return b;
  }
  function setHover(i) {
    if (hoverI === i) return;
    hoverI = i;
    var w = document.querySelectorAll('#x-plot .wash');
    for (var j = 0; j < w.length; j++) w[j].setAttribute('class', 'wash' + (j === st.sel ? ' sel' : '') + (j === i ? ' hov' : ''));
  }
  var tip = null;
  function showTip(i, anchor) {
    if (!tip) { tip = h('div', { class: 'x-tip', role: 'presentation' }); document.body.appendChild(tip); }
    var c = chart.data[i], total = c[0] + c[1] + c[2] + c[3] + c[4];
    tip.textContent = '';
    tip.appendChild(h('div', { class: 'tt', text: bucketLabel(i, chart.edges, true) }));
    tip.appendChild(h('div', { class: 'tr total' }, [h('b', { text: fmtN(total) }), ' people']));
    for (var k = 0; k < 5; k++) {
      if (st.hidden[CATS[k].k]) continue;
      tip.appendChild(h('div', { class: 'tr' }, [h('i', { style: 'background:' + CATS[k].color }), h('b', { text: fmtN(c[k]) }), ' ' + CATS[k].label]));
    }
    tip.appendChild(h('div', { class: 'th', text: st.sel === i ? 'Click again to show the whole range' : 'Click to show just this ' + RANGES[st.range].unit }));
    tip.style.display = 'block';
    var r = anchor.getBoundingClientRect(), w = tip.offsetWidth, hh = tip.offsetHeight, vw = document.documentElement.clientWidth;
    var x = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), vw - w - 8), y = r.top - hh - 8;
    if (y < 8) y = r.bottom + 8;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }
  function hideTip() { if (tip) tip.style.display = 'none'; }

  function legend() {
    return CATS.map(function (c) {
      var shown = !st.hidden[c.k];
      return h('button', {
        type: 'button', class: 'lg', 'aria-pressed': shown ? 'true' : 'false', title: shown ? 'Hide from the chart' : 'Show on the chart',
        onclick: function () { st.hidden[c.k] = shown; render(); }
      }, [h('i', { style: 'background:' + c.color, 'aria-hidden': 'true' }), c.label]);
    });
  }

  function srTable() {
    var e = chart.edges;
    return h('table', { class: 'sr-only' }, [
      h('caption', { text: 'People per ' + RANGES[st.range].unit + ', by what happened' }),
      h('thead', null, [h('tr', null, [h('th', { text: 'When' })].concat(CATS.map(function (c) { return h('th', { text: c.label }); })))]),
      h('tbody', null, chart.data.map(function (c, i) { return h('tr', null, [h('th', { text: bucketLabel(i, e, true) })].concat(c.map(function (v) { return h('td', { text: String(v) }); }))); }))
    ]);
  }

  // ---------- sections ----------
  function delta(cur, prev, label) {
    var d = cur - prev;
    if (!d) return h('div', { class: 'kd' }, ['Same as ' + label]);
    var p = prev >= 20 ? ' (' + (d > 0 ? '+' : '') + Math.round((d / prev) * 100) + '%)' : '';
    return h('div', { class: 'kd ' + (d > 0 ? 'up' : 'down') }, [h('span', { 'aria-hidden': 'true', text: d > 0 ? '▲ ' : '▼ ' }), (d > 0 ? '+' : '−') + fmtN(Math.abs(d)) + p + ' vs ' + label]);
  }
  function kpis(cur, prev, priorLabel) {
    var small = cur.a < 20;
    var chrome = cur.fam[0], safari = cur.fam[1];
    var costLine = cur.l ? money(cur.cents / cur.l) + ' Delivr cost per lead' : cur.cents ? money(cur.cents) + ' Delivr cost, no leads yet' : 'No Delivr cost';
    return [
      h('div', { class: 'kpi' }, [h('div', { class: 'kl', text: 'People' }), h('div', { class: 'kv', text: fmtN(cur.people) }), h('div', { class: 'ks', text: fmtN(cur.views) + ' page views' }), delta(cur.people, prev.people, priorLabel)]),
      h('div', { class: 'kpi' }, [
        h('div', { class: 'kl', text: 'Match rate' }),
        h('div', { class: 'kv' + (small ? ' thin' : ''), text: pctOf(cur.m, cur.a) }),
        h('div', { class: 'ks', text: fmtN(cur.m) + ' of ' + fmtN(cur.a) + ' people asked' + (small && cur.a ? ' · too few to judge yet' : '') }),
        h('div', { class: 'kd', text: 'Chrome-type ' + chrome[1] + ' of ' + chrome[0] + ' · Safari ' + safari[1] + ' of ' + safari[0] }),
        h('div', { class: 'kd', text: 'Before: ' + prev.m + ' of ' + prev.a + ' (' + priorLabel.replace('the ', '') + ')' })
      ]),
      h('div', { class: 'kpi' }, [h('div', { class: 'kl', text: 'Leads' }), h('div', { class: 'kv accent', text: fmtN(cur.l) }), h('div', { class: 'ks', text: costLine }), delta(cur.l, prev.l, priorLabel)])
    ];
  }

  function funnel(cur) {
    var steps = [
      { label: 'Visited', n: cur.people, note: 'Different browsers' },
      { label: 'Could be looked up', n: cur.e, note: 'Passed the privacy checks' },
      { label: 'Asked Delivr', n: cur.a },
      { label: 'Delivr matched', n: cur.m },
      { label: 'Became a lead', n: cur.l, lead: true }
    ];
    var worst = -1, worstLoss = 0;
    for (var i = 1; i < steps.length; i++) { var loss = steps[i - 1].n - steps[i].n; if (loss > worstLoss) { worstLoss = loss; worst = i; } }
    var base = steps[0].n || 1;
    var list = h('ol', { class: 'fun' }, steps.map(function (s, i) {
      var prev = i ? steps[i - 1].n : 0;
      return h('li', null, [
        h('div', { class: 'fl' }, [s.label, s.note ? h('span', { class: 'small muted', text: ' · ' + s.note }) : null]),
        h('div', { class: 'ft' }, [h('span', { class: s.lead ? 'lead' : '', style: 'width:' + Math.max(s.n ? 1.5 : 0, (s.n / base) * 100) + '%' })]),
        h('div', { class: 'fn' }, [
          h('b', { text: fmtN(s.n) }),
          i ? h('span', { class: 'small muted', text: ' ' + pctOf(s.n, prev) + ' of the step before (' + s.n + ' of ' + prev + ')' }) : null,
          i === worst ? h('span', { class: 'drop', text: 'Biggest drop' }) : null
        ])
      ]);
    }));
    var why = Object.keys(cur.why).map(function (k) { return DI.why[+k] + ' (' + cur.why[k] + ')'; });
    return [list, why.length ? h('p', { class: 'small note', text: 'Matched but not sent: ' + why.join(', ') + '.' }) : null];
  }

  function browsers(cur) {
    return [h('ul', { class: 'fam' }, FAMS.map(function (name, i) {
      var a = cur.fam[i][0], m = cur.fam[i][1], on = hasFilter('fam', i);
      return h('li', null, [h('button', { type: 'button', class: 'row' + (on ? ' on' : ''), 'aria-pressed': on ? 'true' : 'false', onclick: function () { toggleFilter('fam', i); } }, [
        h('span', { class: 'nm', text: name }),
        h('span', { class: 'meter' }, [h('span', { style: 'width:' + (a ? (m / a) * 100 : 0) + '%' })]),
        h('span', { class: 'v' }, [h('b', { text: pctOf(m, a) }), h('span', { class: 'small muted', text: ' ' + m + ' of ' + a + ' asked' })])
      ])]);
    }))];
  }

  function breakdownSection(a, b) {
    var tabs = TABS.map(function (k) {
      return h('button', { type: 'button', class: 'tab', 'aria-pressed': st.tab === k ? 'true' : 'false', onclick: function () { st.tab = k; st.blimit = 15; render(); } }, [DIMS[k].label]);
    });
    put('x-tabs', tabs);
    var rows = breakdown(a, b, st.tab), d = DIMS[st.tab];
    if (!rows.length) return [h('p', { class: 'muted empty-note', text: 'Nothing in this range.' })];
    var maxP = rows.reduce(function (m, r) { return Math.max(m, r.people); }, 0);
    var cols = [
      { k: 'name', label: d.label, text: true },
      { k: 'people', label: 'People' },
      { k: 'e', label: 'Could be looked up' },
      { k: 'a', label: 'Asked' },
      { k: 'm', label: 'Matched' },
      { k: 'l', label: 'Leads' },
      { k: 'rate', label: 'Match rate' }
    ];
    var t = dynTable('x-btable', cols, rows, st.bsort, st.blimit, function (r, c) {
      if (c.k === 'name') {
        var on = hasFilter(st.tab, r.v);
        return h('td', { class: 'nmcell' }, [h('button', { type: 'button', class: 'link' + (on ? ' on' : ''), 'aria-pressed': on ? 'true' : 'false', title: on ? 'Remove this filter' : 'Show only this on the whole page', onclick: function () { toggleFilter(st.tab, r.v); } }, [r.name]),
          h('span', { class: 'pbar', 'aria-hidden': 'true' }, [h('span', { style: 'width:' + (maxP ? (r.people / maxP) * 100 : 0) + '%' })])]);
      }
      if (c.k === 'rate') return h('td', null, r.a ? [h('b', { text: pctOf(r.m, r.a) }), h('span', { class: 'small muted', text: ' ' + r.m + ' of ' + r.a })] : [h('span', { class: 'muted', text: '—' })]);
      var v = r[c.k];
      return h('td', { class: v ? '' : 'zero', text: fmtN(v) });
    }, render);
    var more = rows.length > st.blimit ? h('button', { type: 'button', class: 'btn sec sm', onclick: function () { st.blimit = rows.length; render(); } }, ['Show all ' + rows.length]) : null;
    return [h('div', { class: 'tablecard scroll' }, [t]), h('div', { class: 'below' }, [h('span', { class: 'small muted', text: 'Click a name to filter the whole page to it. People can show in more than one row, so rows do not add up to the total.' }), more])];
  }

  function visits(a, b) {
    var rows = [];
    scan(a, b, function (r) { rows.push(r); });
    if (!rows.length) return [h('p', { class: 'muted empty-note', text: 'No visits in this range' + (st.f.length ? ' with these filters.' : '.') })];
    var cols = [
      { k: 't', label: 'When', sv: function (r) { return r[T]; } },
      { k: 'site', label: 'Page', text: true, sv: function (r) { return DI.site[r[SITE]] + ' ' + DI.path[r[PATH]]; } },
      { k: 'place', label: 'From', text: true, sv: function (r) { return DI.place[r[PLACE]]; } },
      { k: 'dev', label: 'Device', text: true, sv: function (r) { return DI.dev[r[DLAB]]; } },
      { k: 'net', label: 'Network', text: true, sv: function (r) { return DI.net[r[NET]]; } },
      { k: 'who', label: 'Who', text: true, sv: function (r) { return DI.tag[r[VIS]]; } },
      { k: 'what', label: 'What happened', text: true, sv: function (r) { return DI.out[r[OLAB]]; } }
    ];
    var multiSite = DI.site.length > 1;
    var t = dynTable('x-vtable', cols, rows, st.vsort, st.vlimit, function (r, c) {
      switch (c.k) {
        case 't': return h('td', { class: 'nowrap', title: new Date(r[T]).toISOString() }, [fWhen(r[T])]);
        case 'site': return h('td', null, [multiSite ? h('span', { class: 'small muted', text: DI.site[r[SITE]] + ' ' }) : null, DI.path[r[PATH]]]);
        case 'place': return h('td', { text: DI.place[r[PLACE]] });
        case 'dev': return h('td', { class: 'nowrap', text: DI.dev[r[DLAB]] });
        case 'net': return h('td', { class: 'small', text: DI.net[r[NET]] });
        case 'who': return h('td', null, [h('button', { type: 'button', class: 'link tag', title: 'Show only this browser', onclick: function () { toggleFilter('vis', r[VIS]); } }, [DI.tag[r[VIS]] || '?'])]);
        default: return h('td', null, [outcome(r)]);
      }
    }, render);
    var more = rows.length > st.vlimit ? h('button', { type: 'button', class: 'btn sec sm', onclick: function () { st.vlimit += 100; render(); } }, ['Show 100 more']) : null;
    return [h('div', { class: 'tablecard scroll' }, [t]), h('div', { class: 'below' }, [h('span', { class: 'small muted', text: 'Showing ' + fmtN(Math.min(st.vlimit, rows.length)) + ' of ' + fmtN(rows.length) + ' page views. Click a "Who" tag to follow one browser.' }), more])];
  }
  function outcome(r) {
    var k = OUTK[r[OKIND]], label = DI.out[r[OLAB]];
    if (r[LEAD] >= 0) return h('a', { href: '/admin/leads/' + encodeURIComponent(DI.lead[r[LEAD]]), class: 'pill ok' }, ['Lead']);
    if (k === 'waiting') return h('span', { class: 'pill new', text: label });
    if (k === 'error') return h('span', { class: 'pill bad', text: label });
    return h('span', { class: 'small', text: label });
  }

  function chips(e) {
    var out = [];
    if (st.sel !== null) out.push(h('button', { type: 'button', class: 'chip', onclick: function () { st.sel = null; render(); } }, ['Only ' + bucketLabel(st.sel, e, true), h('span', { 'aria-hidden': 'true', text: ' ×' }), h('span', { class: 'sr-only', text: ' (remove)' })]));
    st.f.forEach(function (f) {
      out.push(h('button', { type: 'button', class: 'chip', onclick: function () { toggleFilter(f.k, f.v); } }, [DIMS[f.k].label + ': ' + filterName(f), h('span', { 'aria-hidden': 'true', text: ' ×' }), h('span', { class: 'sr-only', text: ' (remove)' })]));
    });
    if (out.length > 1) out.push(h('button', { type: 'button', class: 'chip clear', onclick: function () { st.sel = null; st.f = []; render(); } }, ['Clear all']));
    return out;
  }

  // ---------- URL ----------
  function readUrl() {
    var p = new URLSearchParams(location.search);
    if (RANGES[p.get('range')]) st.range = p.get('range');
    (p.get('f') || '').split(',').forEach(function (s) {
      var m = /^([a-z]+)~(-?\d+)$/.exec(s);
      if (m && DIMS[m[1]]) st.f.push({ k: m[1], v: +m[2] });
    });
    var at = +p.get('at');
    if (at) { var e = edgesFor(st.range), i = e.indexOf(at); if (i >= 0 && i < e.length - 1) st.sel = i; }
  }
  function writeUrl(e) {
    var p = new URLSearchParams();
    if (st.range !== '7d') p.set('range', st.range);
    if (st.sel !== null) p.set('at', String(e[st.sel]));
    if (st.f.length) p.set('f', st.f.map(function (f) { return f.k + '~' + f.v; }).join(','));
    var q = p.toString();
    try { history.replaceState(null, '', location.pathname + (q ? '?' + q : '')); } catch (err) { /* sandboxed previews */ }
  }

  // ---------- render ----------
  function render() {
    var e = edgesFor(st.range), n = e.length - 1;
    if (st.sel !== null && (st.sel < 0 || st.sel >= n)) st.sel = null;
    var a = st.sel === null ? e[0] : e[st.sel], b = st.sel === null ? e[n] : e[st.sel + 1], len = b - a;
    var winLabel = st.sel === null ? RANGES[st.range].label : bucketLabel(st.sel, e, true);
    var priorLabel = st.sel === null ? RANGES[st.range].prior : RANGES[st.range].unit === 'hour' ? 'the hour before' : 'the day before';
    var cur = people(a, b), prev = people(a - len, a);
    chart = { edges: e, data: chartData(e) };

    var rb = document.querySelectorAll('#x-ranges button');
    for (var i = 0; i < rb.length; i++) rb[i].setAttribute('aria-pressed', rb[i].getAttribute('data-range') === st.range ? 'true' : 'false');
    var wl = document.querySelectorAll('.x-win');
    for (var j = 0; j < wl.length; j++) wl[j].textContent = winLabel;
    document.getElementById('explore').classList.toggle('filtered', st.sel !== null || st.f.length > 0);

    put('x-chips', chips(e));
    put('x-kpis', kpis(cur, prev, priorLabel));
    put('x-legend', legend());
    put('x-unit', [RANGES[st.range].unit === 'hour' ? 'People per hour' : 'People per day', '. Someone who came twice shows in both bars. Central time.']);
    drawChart();
    put('x-sr', [srTable()]);
    put('x-status', [st.sel === null ? '' : 'Showing ' + winLabel + ' only.']);
    put('x-funnel', funnel(cur));
    put('x-browsers', browsers(cur));
    put('x-breakdown', breakdownSection(a, b));
    put('x-visits', visits(a, b));
    writeUrl(e);
    if (refocus && refocus.chart !== undefined) {
      var hb = document.querySelectorAll('#x-plot .hit')[refocus.chart];
      refocus = null;
      if (hb) hb.focus();
    } else restoreFocus();
  }

  var rb0 = document.querySelectorAll('#x-ranges button');
  for (var i = 0; i < rb0.length; i++) rb0[i].addEventListener('click', function () { st.range = this.getAttribute('data-range'); st.sel = null; focusI = -1; st.vlimit = 25; render(); });
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && st.sel !== null && !(document.activeElement && document.activeElement.classList.contains('hit'))) { st.sel = null; render(); } });
  window.addEventListener('scroll', hideTip, { passive: true });
  var raf = 0, lastW = 0;
  function onResize() { var w = document.getElementById('x-plot').clientWidth; if (w === lastW) return; lastW = w; cancelAnimationFrame(raf); raf = requestAnimationFrame(function () { if (chart) drawChart(); }); }
  if (window.ResizeObserver) new ResizeObserver(onResize).observe(document.getElementById('x-plot')); else window.addEventListener('resize', onResize);
  readUrl();
  render();
  lastW = document.getElementById('x-plot').clientWidth;
  document.getElementById('explore').classList.add('ready');
})();

// Sort the tables the server draws (leads, delivery, sites): a button in each header, aria-sort on the sorted one.
(function () {
  var coll = new Intl.Collator('en-US', { numeric: true, sensitivity: 'base' });
  document.addEventListener('click', function (ev) {
    var btn = ev.target.closest && ev.target.closest('table.sortable th button');
    if (!btn) return;
    var th = btn.closest('th'), table = btn.closest('table'), col = th.cellIndex, num = th.classList.contains('n');
    var dir = th.getAttribute('aria-sort') === (num ? 'descending' : 'ascending') ? (num ? 'ascending' : 'descending') : (num ? 'descending' : 'ascending');
    var heads = table.querySelectorAll('th');
    for (var i = 0; i < heads.length; i++) { heads[i].removeAttribute('aria-sort'); var a = heads[i].querySelector('.arr'); if (a) a.textContent = '↕'; }
    th.setAttribute('aria-sort', dir);
    btn.querySelector('.arr').textContent = dir === 'ascending' ? '▲' : '▼';
    var s = dir === 'ascending' ? 1 : -1, tb = table.tBodies[0];
    var rows = Array.prototype.map.call(tb.rows, function (r) {
      var td = r.cells[col], v = td ? td.getAttribute('data-sort') : null;
      if (v === null) v = td ? td.textContent.trim() : '';
      return { r: r, k: num ? Number(v) || 0 : v };
    });
    rows.sort(function (x, y) { return s * (num ? x.k - y.k : coll.compare(x.k, y.k)); });
    var f = document.createDocumentFragment();
    rows.forEach(function (o) { f.appendChild(o.r); });
    tb.appendChild(f);
  });
})();`;

/** JSON that is safe inside a <script> element: no "</script>", no line separators that end a JS string. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}
