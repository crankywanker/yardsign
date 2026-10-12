# Architecture

How the first slice fits together. Read `docs/SCHEMA.md` for the tables.

## The pieces

```
apps/collector      Cloudflare Worker (Hono). Routes, cron, queue consumer.
packages/pixel      Browser snippet. Built by esbuild into one file under 4 KB.
packages/db         D1 migrations, row types, query helpers. No business logic.
packages/identity   IdentityProvider interface, MockProvider, DelivrProvider stub.
packages/scoring    HailSource interface, MockHailSource, NoaaHailSource (NWS storm reports), CensusGeocoder, scoreVisit().
```

npm workspaces link them. Wrangler and Vitest bundle TypeScript straight from `src/`, so only the pixel has a build step. The old flat MVP at the repo root (`src/`, `schema.sql`, root `wrangler.toml`) is separate and untouched.

## Request flow

```
contractor's page
  <script async src="https://tryyardsign.com/p/SITEKEY.js">   (the host is PUBLIC_BASE_URL)
        |
        v
GET /p/SITEKEY.js  ---- 404 if the key is unknown or the site is off
        |  pixel with site key + collect URL baked in, cached 1 hour, ETag per build+key
        v
browser runs the pixel
  - reads or creates _ys_vid (cookie, 1 year, SameSite=Lax; localStorage as backup)
  - reads or rotates _ys_sid (30 minutes idle)
  - POST /collect as text/plain via fetch (keepalive, cors mode, so the page's real Origin is sent);
    sendBeacon only where fetch is missing. Ad blockers' beacon rule does not block fetch
  - again on pushState / popstate, and an "unload" beacon with time on page
        |
        v
POST /collect
  1. size check (8 KB), parse, validate (shape, UUIDs, URL scheme, string caps)
  2. site lookup by key; inactive or unknown -> 204, nothing stored
  3. CORS: Origin must match one of the site's allowed_domains -> else 403
  4. read request.cf: country, region, city, postal, asn, colo, lat, lng, bot score
  5. geo block (EU/EEA/UK/CH) -> 204, nothing stored
  6. bot drop (UA pattern, bot score < 30, verifiedBot) -> 204, nothing stored
  7. hash the IP with IP_SALT; rate limit per site and per IP hash -> 429
  8. "unload" beacon: UPDATE visits.time_on_page_ms, done
  9. "view" beacon: upsert visitors, insert visits (ip_raw kept 72 h), return 204
 10. after the response (waitUntil): hand off to the ResolutionScheduler,
     then write a ZIP-level lead_scores row
        |
        v
resolution step (processVisit)        <- queue consumer, or the 5-minute cron in poll mode
  - skip if the visit was already attempted, or the site is off
  - gate 1 (src/policy.ts, stored as visits.skip_reason): bot_or_datacenter (known bots only;
    a cost filter, not a privacy rule), gpc, non_us, not_allowed_state (a known state outside
    ALLOWED_STATES = ['TX']). Since Oct 8 (PR #50) a visit with an unknown region passes, and so
    does a data-center network (iCloud Private Relay, Cloudflare WARP, Google Fi, office VPNs).
    The same function decides whether /p/SITEKEY.js carries the Delivr id, and the demo card uses it.
  - 30-day rule: skip if this visitor on this site has a full lead (name and street address)
    in the last 30 days. An email-only (partial) lead or a miss stays open for RECHECK_DAYS
    (default 7) from the first match or billed lookup, so a return visit is looked up again;
    after that, skip. A free miss does not start that clock (Oct 8).
    A re-check that finds no more than the partial lead we have makes no second card.
  - Confidence: the provider's score, then src/confidence.ts (+0.05 same ZIP as the visit, -0.25
    another state, -0.15 on cell data). Below MIN_CONFIDENCE no lead (low_confidence). The
    default is 0 since Oct 8, so every match goes out with its score. Runs after gate 2, so a
    withheld match never gets this far.
  - "They're back": on every final exit that makes no new lead, if the visitor already has a
    lead and this is the first view of a new session, email the site's lead address once per
    visitor per 24 h (deliveries.channel = email:return). Gate 1 runs first.
  - paid providers only (src/spend.ts): one billed call or match per visitor per 24 h
    (deduped_24h). A free miss does not count, so the next visit is asked again (Oct 8).
    The engagement gate (2+ views or 10 s on a page, else wait 30 min then no_engagement) is off
    unless DELIVR_ENGAGEMENT_GATE = "on". Then the provider's minimum visit age, then the monthly
    and daily spend caps (spend_cap, daily_spend_cap, spend_check_error), which also email the operator
  - after a match, gates 3 and 2 (src/policy.ts): opted out or GPC, then the home address OR the
    visit must be in ALLOWED_STATES. A Texas home address passes, and so does a visit from Texas
    (since Oct 8), even when the address has no state or another state. A failed match is never a
    lead: skip_reason out_of_state_address / no_address_state, and the raw answer is scrubbed after
    30 days by the cron
  - insert identity_requests (pending) -> provider.resolve() -> update status + cost
  - on resolved: drop the match if its email is in optouts; else insert leads (with email_hash),
    run every delivery channel the site has, write an address-level lead_scores row
  - mark visits.resolve_attempted_at either way
        |
        v
delivery: one deliveries row per channel the site has set up
  - email (site.lead_email + EMAIL_PROVIDER): the lead card, html + text, through Resend or Postmark
  - webhook (site.webhook_url): json | slack | ghl body, https only, never to our own host or a private address. Every shape carries the hail: a `hail` object in json (null when not scored), a line in slack, a `yardsign-hail` tag and `hail` field in ghl
  - log: when the site has neither, so a lead row is never lost
```

Every log line is one JSON object with `req_id` (the `cf-ray`, or a UUID in dev), so one request can be pulled out of the stream with a single grep.

## Where the choices were made

**Claim before paying.** Before a provider call the step writes the pending `identity_requests` row with one `INSERT … WHERE NOT EXISTS` (`claimIdentityRequest`): it refuses when this visitor on this site already has a lookup in flight (pending, under 10 minutes old) or, for Delivr, a billed, matched or dead lookup in the last 24 hours. Two overlapping runs (a slow cron, the admin "resolve" button, two page views of one visitor) can never both pay; the loser returns `busy` and leaves the visit for later. The answer, the lead (with its `lead_keys`) and the visit mark are written in one batch. A pending row counts at the worst-case cost in the spend caps, so a run that died mid-call is still counted. For a paid provider the step also stops before paying when the account has used its monthly households (`over_quota`); mock leads never count.

**Queue or poll.** `src/scheduler.ts` holds the `ResolutionScheduler` interface. `getScheduler(env)` returns `QueueScheduler` when `env.RESOLVE_QUEUE` is bound and `PollScheduler` otherwise. Queues need the paid Workers plan, so the queue blocks in `wrangler.toml` ship commented out and the collector runs in poll mode. In poll mode the cron every five minutes runs `pollUnresolvedVisits`, which reads visits with `resolve_attempted_at IS NULL`. Switching is a config change: uncomment the two blocks and deploy. `GET /health` reports which mode is live.

**Rate limiting in D1, not a Durable Object.** A Durable Object gives an exact counter but needs a class, a migration block, a second binding, and a hop to another isolate on every beacon. The D1 version is one upsert and one read on a table the request already uses, works on the free plan, and is accurate enough for abuse control. It is a two-bucket sliding window: the current minute's count plus the previous minute's count weighted by the time left in the current minute. Limits are `RATE_LIMIT_SITE_PER_MIN` (600) and `RATE_LIMIT_IP_PER_MIN` (60). The cron prunes old buckets. If D1 write volume ever matters, swap the function body for a Durable Object or the Workers rate-limit binding; the call site does not change.

**text/plain beacons.** A `text/plain` POST is a CORS "simple request", so the browser sends no preflight. Since Oct 8 the pixel sends with `fetch` first: in cors mode it always carries the page's real Origin, while `sendBeacon` sends `Origin: null` on sites with a strict Referrer-Policy, and EasyPrivacy blocks third-party beacons by type. An `Origin: null` view is checked against the page URL in its payload instead (`collectCors`). The server parses the body as JSON no matter what the header says, and reads at most 8 KB of it even without a Content-Length. The `OPTIONS /collect` handler exists for customers' own code that might trigger a preflight; pass `?k=SITEKEY` so it can check the origin.

**Pixel picks the visit id.** Each page view gets a UUID in the browser. The unload beacon carries the same id, so the server updates `time_on_page_ms` in place instead of inserting a second row. The id must look like a UUID and the update is scoped to the same site and visitor, so a visitor can only touch their own rows. A replayed view beacon fails the primary key and is dropped.

**Raw IP for 72 hours.** `ip_raw` is on the visits row so a provider can use it while it is fresh. The cron nulls it after 72 hours. `identity_requests.request_payload` never contains it; it records `ip_present: true/false` instead. `/api/admin/visits` never returns it.

**30-day rule includes no_match.** The brief says check leads. A visitor who never matches would otherwise go to the vendor on every page view, and every call costs money, so a recent `no_match` also counts. Errors do not, so a vendor outage is retried next visit.

**Scoring twice.** Right after the visit, `scoreAndStore` runs with `lead = null` using the visit's coordinates from `request.cf` (ZIP level). After a lead is created, the Census geocoder (`GEOCODER`) turns the home address into `leads.lat/lng`, and scoring runs again from the house, before delivery, so the email card can show the hail (`apps/collector/src/email/hail.ts`). If the address does not map, it falls back to the visit location and records `location.source: "visit"`; the card then leaves out the distance and says why. The window is six months and recency counts most (version 2). The formula is in `packages/scoring/src/score.ts` and all its inputs are written to `components`, so changing it later does not orphan old rows.

**Hail events come from a sync, not a live call.** `syncHailEvents(db, source, bbox, since)` upserts by `(source, external_id)`. `HAIL_SOURCE = "noaa"` reads the NWS Local Storm Reports for Texas from the Iowa Environmental Mesonet (free, no key), hail only. The cron runs every hour for the last 3 days and at 03:23 UTC for the full six months; `POST /api/admin/hail/sync` (optional `?days=`) runs it now. With a real source, the sync deletes rows from every other source, and scoring only reads the configured source, so fake mock hail never reaches a real card. A NOAA report's id is the report itself (office, time, type, place), not the NWS product that carried it, so a correction replaces the first copy; the sync also deletes rows in the window it just pulled that still carry the old id (product id first, before Oct 8). Scoring only reads the table. When the house could not be mapped, the card's hail line (found or "none reported") says it is measured from where they were browsing, and the JSON says `measured_from: "visit"`. The mock source returns dates relative to now, so a re-sync keeps them fresh. In local dev `wrangler dev` pretends every request comes from Chicago, so the mock source includes one Chicago event or local scores would always be 0.

**Email behind a sender interface.** `src/email/sender.ts` holds `EmailSender` with Resend and Postmark implementations; both are one HTTPS call. `getEmailSender(env)` returns null when `EMAIL_PROVIDER` is unset. A site with a `lead_email` but no working sender gets a `failed` email delivery with `last_error = email_not_configured` (since Oct 8), so the dashboard and `/admin` show it and the failed-delivery alert fires. Only a site with neither a lead email nor a webhook uses the log channel, which logs the lead and site ids, never the person. Failed deliveries are retried by the 5-minute cron (`retryFailedDeliveries`): 5, 15, 45 and 135 minutes after the first try, at most 5 tries, only within 24 hours, and never for a lead that was deleted or a channel the site no longer has. Each retry claims its row first, so two runs never send twice. SES is not implemented because it needs request signing. The card itself is in `src/email/lead-card.ts`, rendered once to HTML and once to text from the same input, with a "TEST LEAD" banner whenever the provider is the mock.

**Bots are dropped, not stored.** The brief asked for a bot score column either way; it is there and filled when the plan supplies one. Visits that look like bots never reach the table. Loosen `isBot()` if a real plan's bot score turns out to be too aggressive.

## Public pages

`src/routes/site.ts` serves `/` (landing page with the live demo card), `/style.css`, `/demo.json` (rate-limited 30 a minute per IP hash), `/privacy`, `/terms` and `/optout`. The demo card and the resolution gates share `resolveVerdict()` in `src/demo.ts`, so the page can never promise something the pipeline does not do. The founder's own pages carry the `TRYYARDSIGN` pixel. `/checkout` and `/welcome` run Stripe Checkout (see Billing below).

## Crawlers and search

`src/seo.ts` is the one list of public pages (`src/public-pages.json`: path, title, one-line description, and an `updated` date that is bumped by hand when the page changes, never the deploy time). `src/routes/seo.ts` builds `/robots.txt`, `/sitemap.xml`, `/llms.txt`, `/.well-known/security.txt` and the IndexNow key file (`/<key>.txt`, from the `INDEXNOW_KEY` secret) from it. robots.txt allows everything for every crawler, names the search and AI-search bots and the training bots, and disallows only `PRIVATE_PREFIXES` (dashboard, operator page, API, collector, pixel, checkout, Stripe, welcome, demo.json, health). The same list drives a middleware in `app.ts` that adds `X-Robots-Tag: noindex, nofollow` to every private response, since robots.txt alone does not keep a page out of Google. Every public page carries a `<link rel="canonical">` to its clean `https://tryyardsign.com` URL. An unknown path returns a small HTML 404 page when the request accepts HTML and is not an API or collector path; otherwise the JSON 404 stays. Future `/learn/*` articles plug in through `src/learn.ts`: entries with `status: 'live'` join the sitemap and llms.txt, drafts never do. After each deploy to `main`, `scripts/indexnow-ping.mjs` tells IndexNow about pages whose `updated` date changed; a failed ping is logged and never fails the deploy. Cloudflare's managed robots.txt may prepend its own block; check the live file after a deploy.

## Dashboard

`src/routes/app.ts`. One site at a time. Login is `?key=`: a site's `dash_key` opens that site; `ADMIN_TOKEN` opens any site with `?site=`. Pages: `/app` (stats tiles and the leads table with a Hail column from each lead's newest `lead_scores` row; `?sort=hail` ranks by hail score; `?print=1` is the clean view for screenshots), `/app/install` (the tag, a "seen in the last 24 hours" check, the privacy-policy paragraph), `/app/delivery` (email and webhook settings, "send a test lead" goes through the real channels without storing anything). `/app/leads.json?since=` is the feed a calling agent polls, always scoped to one site; each lead has the same `hail` object webhooks get. "Engaged" means 10+ seconds on a page or 2+ page views, and the UI says so next to the number. Magic-link login replaces the key after Oct 30.

## Operator page

`src/routes/admin-page.ts` serves `GET /admin` and `GET /admin/leads/:id`: one read-only HTML page for the operator with every site, every lead, and whether the system is working. The server draws the mode banner, a "Needs attention" list (`attentionItems`: failed deliveries, spend-cap blocks, spend at 80% of a cap, lookup errors, visits stuck over 30 minutes, a Delivr site gone quiet for a day), Delivr spend today and this month against the caps (summed from `cost_cents` like the bill guard), the last 7 days of leads, delivery health and the sites table (sortable by header click). The rest is drawn in the browser by `src/pages/admin-explore.ts` (plain JavaScript, no library) from one compact row per visit on Delivr sites, last 60 days (`exploreData`, embedded as JSON with `<` escaped): a 24 h / 7 d / 30 d switch with change against the period before, a stacked bar chart of what happened to each visitor (click a bar to filter the page to that hour or day), the per-person match funnel, match rate by browser, sortable breakdowns by page, place, network, device, browser and skip reason (click a row to filter), and the visit list. Chart times are Central; spend days reset at midnight UTC like the caps. The range and filters live in the URL. Cloudflare Access fronts the route, and the Worker also verifies the `Cf-Access-Jwt-Assertion` token itself in `src/access.ts` (RS256 signature against the team's published keys, issuer, audience, expiry). No config, no token or a bad token is a 403; the email header alone is never trusted. Responses are `no-store` and `noindex`. The numbers come from `src/admin-stats.ts`, which never selects raw IPs or the provider extras; the leads list carries no address, phone or email, the per-visit rows carry no person fields, and the detail page shows the same fields as the customer's lead card. The Delivr rates live in `DELIVR_RATES` there; the estimate counts rows Delivr returned (stored in each request's response) plus page views on sites with a Delivr pixel. The bearer-token JSON API in `src/routes/admin.ts` lives at `/api/admin/...` (moved Oct 7) so the Access app on `/admin` never sees the machine calls from the Actions-tab workflows.

## Billing

`src/billing.ts` is Stripe Checkout in subscription mode plus one webhook. The Checkout Session id is the idempotency key: `provision()` runs from both the webhook and `/welcome`, whichever lands first, and the unique index on `sites.stripe_session_id` makes a race harmless. Only a complete, paid subscription session for a known plan is provisioned (`async_payment_succeeded` covers delayed methods). A new email gets an account (plan, quota, Stripe ids) and a site whose `lead_email` is the email they paid with, so cards arrive with no setup. The checkout email is not verified, so a checkout never changes an existing account (since Oct 8): it adds a site to one only when Stripe's customer id matches; otherwise the site is created off with `review_reason` set, the operator is emailed at `SPEND_ALERT_EMAIL`, and `/welcome` says setup will be finished by email. The subscription is stored on the site it paid for, and `customer.subscription.deleted` turns off only those sites. At `monthly_quota` (0 means unlimited) the step stops asking Delivr (`over_quota`); a lead that still lands past it has its delivery row `skipped` with `over_quota`. Checkout stays off until all four `STRIPE_*` secrets exist, the webhook secret included. `/checkout` (10 a minute) and `/welcome` (20 a minute) are rate-limited per IP; `/welcome` stops asking Stripe once the site exists, shows an error for an expired session, and stops refreshing after about two minutes.

## Secrets and config

| Name | Where | What |
|---|---|---|
| `ADMIN_TOKEN` | secret | Bearer token for `/api/admin/*`. At least 8 chars or the endpoints refuse everyone. |
| `IP_SALT` | secret | Salt for `ip_hash`. Set once. Changing it breaks the 30-day rule and rate limits for a day. |
| `IDENTITY_PROVIDER` | var | `mock` (default) or `delivr`. |
| `DELIVR_API_KEY`, `DELIVR_API_SECRET` | secrets | Only with `delivr`. |
| `DELIVR_MONTHLY_CAP_CENTS`, `DELIVR_DAILY_CAP_CENTS` | vars | Hard stops on Delivr spend, whole cents. Defaults 125000 ($1,250) and 1000 ($10). See `docs/DELIVR.md`, "Bill protection". |
| `SPEND_ALERT_EMAIL` | var | Who gets the 50% / 80% / cap-hit emails. Unset = logged at error level. |
| `PUBLIC_BASE_URL` | var | Where the pixel posts. Empty means the request origin (local dev). |
| `BUILD_SHA` | var | Shown by `/health`. `npm run deploy` passes the git sha. |
| `RATE_LIMIT_*_PER_MIN` | var | See rate limiting above. |
| `ALLOWED_STATES` | var (tests only) | Overrides the `ALLOWED_STATES` list in `src/policy.ts`. Leave unset; change the code to add a state. |
| `EMAIL_PROVIDER` | var | `resend` or `postmark`. Empty means log-only delivery. |
| `EMAIL_FROM` | var | Sender address. Its domain must be verified at the provider. |
| `EMAIL_API_KEY` | secret | The provider's API key or server token. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PRO` | secrets | All four or checkout is off. |
| `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` | secrets | The Cloudflare Access team (like `yardsign`) and the Access app's audience tag. `/admin` refuses everyone until both exist. |
| `INDEXNOW_KEY` | secret | The IndexNow key (public by design; 8 to 128 letters, digits and dashes). Served at `/<key>.txt`; the deploy pings IndexNow with it. Unset = no key file, no pings. |

Local dev reads `apps/collector/.dev.vars`. Copy it from `.dev.vars.example`. Never commit it.

## Deploys

GitHub Actions owns deploys (`.github/workflows/ci.yml`). Every push and pull request runs typecheck and the full test suite. A push to the default branch also applies the D1 migrations, deploys the Worker with the git sha as `BUILD_SHA`, and runs `scripts/sync-secrets.sh`, which pushes whichever runtime secrets exist as GitHub secrets to Cloudflare with `wrangler secret bulk` and skips the rest. So secrets live in one place, GitHub, and a Claude session never holds a Cloudflare token.

## Cron schedule

| Cron | Does |
|---|---|
| `*/5 * * * *` | In this order, each step on its own so one failure never stops the next: null `ip_raw` older than 72 h, prune rate-limit rows, delete visits older than 13 months that never led to a lead, scrub withheld answers older than 30 days, send opt-out recalls that are due, then the resolution step. In poll mode that is every new visit, round-robin across sites, up to 60 visits or 4 minutes a run; in queue mode only visits older than 30 minutes that the queue never finished. The cleanups go first because one run gets about 1,000 database queries and the poll can use most of them. |
| `23 * * * *` | Retry the Delivr pixel for paid sites that have none (Delivr was down at checkout), then sync the last 3 days of hail from the configured source (the full 6 months at 03:23 UTC). |

`wrangler dev` does not fire crons. `POST /api/admin/resolve` and `POST /api/admin/hail/sync` do the same work on demand.

## What is deliberately not here

No dashboard, Stripe, marketing site, real identity vendor, real hail feed, geocoder, email or webhook delivery, GPC handling, or state-level blocking. Each has a seam: the admin JSON for a dashboard, `accounts.plan` and `stripe_customer_id` for billing, `IdentityProvider` for vendors, `HailSource` for feeds, `leads.lat/lng` for geocoding, `DeliveryChannel` for CRMs, and the geo-block constant for more rules.
