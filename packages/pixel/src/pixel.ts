/**
 * The Yardsign pixel. Installed with one tag:
 *   <script async src="https://cdn.tryyardsign.com/p/SITEKEY.js"></script>
 *
 * The Worker swaps the three tokens below when it serves the file. No imports, no
 * dependencies, must stay under 4 KB minified, must never throw.
 *
 * It sends: page URL, referrer, title, screen and viewport, timezone, language,
 * a first-party visitor id (_ys_vid, 1 year), a session id (_ys_sid, 30-min idle),
 * and timestamps. It never reads form fields, keystrokes, or anything typed.
 */
(function () {
  var w = window as Window & { yardsign?: { disabled?: boolean }; __ys?: number };
  if (w.__ys) return;
  w.__ys = 1;

  // Automated browsers and headless screens are not people. No beacon, no partner script.
  try {
    if ((navigator as Navigator & { webdriver?: boolean }).webdriver || !screen.width || !screen.height) return;
  } catch (e) {
    return;
  }

  var KEY = '__YS_SITE_KEY__';
  var ENDPOINT = '__YS_ENDPOINT__';
  var DELIVR = '__YS_DELIVR__'; // Delivr pixel id for this site, or empty
  var VID = '_ys_vid';
  var SID = '_ys_sid';
  var SESSION_MS = 30 * 60 * 1000;

  function off(): boolean {
    return !!(w.yardsign && w.yardsign.disabled);
  }

  function getCookie(name: string): string {
    try {
      var m = document.cookie.match('(?:^|; )' + name + '=([^;]*)');
      return m && m[1] ? decodeURIComponent(m[1]) : '';
    } catch (e) {
      return '';
    }
  }

  function setCookie(name: string, value: string, maxAgeSec: number): void {
    try {
      document.cookie =
        name + '=' + encodeURIComponent(value) + '; path=/; max-age=' + maxAgeSec + '; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '');
    } catch (e) {
      /* cookies blocked */
    }
  }

  function getLocal(name: string): string {
    try {
      return localStorage.getItem(name) || '';
    } catch (e) {
      return '';
    }
  }

  function setLocal(name: string, value: string): void {
    try {
      localStorage.setItem(name, value);
    } catch (e) {
      /* storage blocked */
    }
  }

  function uuid(): string {
    try {
      if (crypto && crypto.randomUUID) return crypto.randomUUID();
    } catch (e) {
      /* fall through */
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 3) | 8).toString(16);
    });
  }

  // Visitor id: cookie first, localStorage as the fallback, then both are refreshed. Read on the first
  // send, after the kill switch, so a disabled pixel never writes the cookie. Lower case, and anything
  // the server would refuse is replaced.
  var vid = '';
  function visitor(): string {
    if (!vid) {
      vid = (getCookie(VID) || getLocal(VID)).toLowerCase();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(vid)) vid = uuid();
      setCookie(VID, vid, 365 * 86400);
      setLocal(VID, vid);
    }
    return vid;
  }

  // Session id: "<id>.<last activity ms>". A new one starts after 30 idle minutes.
  function session(): string {
    var now = Date.now();
    var raw = getCookie(SID) || getLocal(SID);
    var parts = raw.split('.');
    var id = parts[0];
    var last = parseInt(parts[1] || '0', 10) || 0;
    if (!id || id.length < 8 || now - last > SESSION_MS) id = uuid().replace(/-/g, '').slice(0, 20);
    var next = id + '.' + now;
    setCookie(SID, next, SESSION_MS / 1000);
    setLocal(SID, next);
    return id;
  }

  var current = ''; // visit id for the page view in progress
  var startedAt = 0;
  var hiddenSent = false;

  function send(kind: 'view' | 'unload'): void {
    if (off() || !current) return;
    var p: Record<string, unknown> = {
      k: KEY,
      e: kind,
      id: current,
      vid: visitor(),
      sid: session(),
      ts: Date.now(),
    };
    if (kind === 'view') {
      p.u = location.href;
      p.r = document.referrer || '';
      p.t = document.title || '';
      p.s = {
        w: screen.width,
        h: screen.height,
        vw: w.innerWidth,
        vh: w.innerHeight,
        dpr: w.devicePixelRatio || 1,
      };
      try {
        p.tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      } catch (e) {
        p.tz = '';
      }
      p.l = navigator.language || '';
    } else {
      p.top = Date.now() - startedAt;
    }
    var body = JSON.stringify(p);
    // text/plain keeps this a CORS "simple request": no preflight. fetch in cors mode always sends the
    // page's real Origin; sendBeacon sends "null" on pages with a strict Referrer-Policy, so it is only
    // the fallback for browsers without fetch. A failed fetch is not retried: the server may have it.
    try {
      fetch(ENDPOINT, { method: 'POST', body: body, keepalive: true, mode: 'cors', credentials: 'omit', headers: { 'content-type': 'text/plain' } }).catch(function () {});
      return;
    } catch (e) {
      /* no fetch: fall back to sendBeacon */
    }
    try {
      navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'text/plain' }));
    } catch (e) {
      /* give up quietly */
    }
  }

  function view(): void {
    if (off()) return;
    current = uuid();
    startedAt = Date.now();
    hiddenSent = false;
    send('view');
  }

  function leave(): void {
    if (hiddenSent) return;
    hiddenSent = true;
    send('unload');
  }

  // SPA route changes: pushState and popstate. replaceState is left alone on purpose.
  var lastHref = location.href;
  function routeChanged(): void {
    setTimeout(function () {
      if (location.href === lastHref) return;
      leave();
      lastHref = location.href;
      view();
    }, 0);
  }
  try {
    var push = history.pushState;
    history.pushState = function () {
      var r = push.apply(history, arguments as unknown as Parameters<typeof push>);
      routeChanged();
      return r;
    };
    w.addEventListener('popstate', routeChanged);
  } catch (e) {
    /* history API blocked */
  }

  // Time on page: fire when the tab is hidden or the page is going away, once per view.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') leave();
    else hiddenSent = false;
  });
  w.addEventListener('pagehide', leave);

  // Identity partner pixel (Delivr), only for sites that have one. It sets its own cookie and
  // matches it in their graph; we tag every one of its events with our visitor id so the
  // resolution step can join them. Skipped when the browser asks not to be tracked (GPC).
  // Loaded right after the page view: Delivr matches a browser on its first event or not at all,
  // so a visitor who leaves in two seconds still gets a chance. Automated browsers stopped above.
  var partnerDone = false;
  function partner(): void {
    if (partnerDone || !DELIVR || off()) return;
    partnerDone = true;
    try {
      if ((navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl) return;
      if (document.querySelector('script[data-ys-partner]')) return;
      var s = document.createElement('script');
      s.async = true;
      s.src = 'https://cdn.sitelytics.tech/pixels/' + DELIVR + '/p.js';
      s.setAttribute('data-pixel-id', DELIVR);
      s.setAttribute('data-ys-partner', '1');
      s.setAttribute('data-global-params', JSON.stringify({ ys_vid: visitor(), ys_key: KEY }));
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {
      /* never break the host page */
    }
  }

  view();
  partner();
})();
