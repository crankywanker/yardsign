# Schema

Migrations live in `packages/db/migrations`. Apply them with `npm run collector:migrate` (local) or `npm run migrate:remote -w @yardsign/collector`. Row types and query helpers are in `packages/db/src`.

Rules that hold everywhere:

- Timestamps are integer milliseconds since the Unix epoch. SQLite has no date type, and integers compare fast.
- Ids are UUID strings, except `visitors.id`, which is the browser cookie value.
- Columns marked JSON hold a JSON string. Parse them with `parseJson()` from the db package.
- Every table that belongs to a customer carries `site_id`. Multi-tenant from day one.

## accounts

One row per paying (or trial) customer. `plan` is `trial`, `starter` or `pro`; the prices live in code. `stripe_customer_id` and `stripe_subscription_id` come from the Checkout that created the account; since Oct 8 a later checkout never changes them (the subscription lives on the site, see `sites`). `monthly_quota` (migration 0007) is identified households per calendar month, 0 for unlimited; the founder's own account is 0. `status` is `active` or `suspended`; suspended accounts are never resolved, their pixel 404s and `/collect` drops their visits. Since Oct 8 a cancelled subscription turns off its site instead of suspending the account.

## sites

One website per row. An account can have many. `site_key` is public and goes in the pixel URL, so it is unique and indexed. `allowed_domains` is a JSON list of hostnames allowed to POST to `/collect`. That list is the CORS allow-list. `active = 0` turns the pixel off: `/p/:siteKey.js` returns 404 and `/collect` drops the visit. `lead_email` (migration 0004) is where this site's lead cards are emailed. `webhook_url` and `webhook_kind` (migration 0005, kind `json`, `slack` or `ghl`) post each lead to a webhook too. Both NULL means leads are only logged. `stripe_session_id` (migration 0007) is the Checkout Session that created the site, unique, so provisioning can run twice safely. `dash_key` (migration 0008) opens the site's dashboard; it is a secret and is shown once on `/welcome`. `delivr_pixel_id` (migration 0009) is the site's Delivr pixel; NULL means the mock provider. `pixel_seen_at` (migration 0010) is the last time `/p/KEY.js` was fetched, written at most once every five minutes per site; `/admin` shows it as "install seen". `stripe_subscription_id` (migration 0015, indexed) is the subscription that pays for this site; cancelling it sets `active = 0` here. `review_reason` (migration 0015) is set when a paid site was created off for the operator to check, today only `email_has_account_with_other_stripe_customer`; the operator turns it on by hand.

## visitors

One row per browser per site. `id` is the first-party `_ys_vid` cookie the pixel sets. The primary key is `(site_id, id)` because the same person on two customer sites is two different visitors to us. `visit_count` and `last_seen_at` are bumped on every page view.

## visits

One row per page view. This is the biggest table. The pixel picks the row id so the unload beacon can come back and set `time_on_page_ms` on the same row.

- `ip_hash` is `sha256(IP_SALT + "|" + ip)`. It is what we rate limit and dedupe on. It never leaves the database.
- `ip_raw` is the real IP, kept for 72 hours so the identity vendor can use it. A cron sets it to NULL after that. Nothing else may read it.
- `country`, `region`, `city`, `postal`, `asn`, `colo`, `lat`, `lng` come from Cloudflare's `request.cf`, not from the browser.
- `device` (JSON: type, browser, os) is parsed from the user agent on the server. `screen` (JSON: w, h, vw, vh, dpr), `timezone` and `language` come from the browser.
- `bot_score` is Cloudflare's 1-99 bot score when the plan provides it, else NULL. Visits we think are bots are never stored at all.
- `occurred_at` is the browser clock; `created_at` is the server clock. Use `created_at` for anything that matters.
- `resolve_attempted_at` is set once the resolution step has looked at this visit, whether or not it called a provider. The poll fallback uses it to find new work. The partial index on NULL values keeps that query cheap.
- `gpc`, `asn_org`, `asn_class` (migration 0006) are the signals the resolution gates read. `skip_reason` says why a visit was not sent to a provider, or why its match was not delivered: since Oct 7, 2026 `bot_or_datacenter`, `gpc`, `non_us`, `region_unknown`, `not_allowed_state`, `out_of_state_address`, `no_address_state`, `opted_out` (since Oct 8 also before any lookup, for a browser that opted out), `over_quota` (the account used its monthly households, so Delivr was not asked), `unfinished_match` (an old run stored a match but stopped before the lead), plus the dedupe, engagement and spend reasons. Older rows may carry `outside_us`, `blocked_state`, `mobile`, `relay` or `hosting`. A withheld match keeps `identity_requests.response_payload.withheld`; the cron cuts that payload to `{rows, withheld, scrubbed}` after 30 days. The dashboard's "abstained, and why" number comes from here.

Indexes: `(site_id, occurred_at)` for the admin list and the dashboard later, `(site_id, visitor_id)` for per-visitor history, and partial indexes for the poll and the raw-IP cleanup. Migration 0014 adds `created_at` (the `/admin` visit list and the 13-month cleanup), `(site_id, created_at)` (per-site counts) and `(site_id, session_id)` (the engagement gate).

## identity_requests

One row per call to an identity provider. Written as `pending` before the call and updated to `resolved`, `no_match` or `error` after. `request_payload` and `response_payload` keep what was sent and received so a bad match can be traced. `cost_cents` is whatever the provider reports, rounded to a whole cent. Indexed on `status` for the pending/error views, on `visit_id`, on `(provider, created_at)` for the spend caps, and on `created_at` for `/admin` (migration 0014).

A visit with no request row was either skipped by the 30-day rule or not yet processed. Look at `visits.resolve_attempted_at` to tell which.

Visits older than 13 months are deleted by the cron with their request rows and score rows, unless the visit led to a lead (Oct 8; before that, any visit that had a lookup was kept).

## leads

One row per identified household. Points at the `identity_requests` row that produced it. The name, address, phone and email columns mirror what every provider returns. `confidence` is 0 to 1.

- `lat`, `lng` will be geocoded from the address. NULL until geocoding exists. Scoring falls back to the visit's coordinates.
- `linkedin_url` is for the founder's own site, where visitors are business owners.
- `extra` is a JSON object for trade-specific fields later, like `roof_age` or `year_built`. Do not add those as columns.
- `email_hash` (migration 0006) is sha256 of the normalized email, so an opt-out can find and delete the lead without a scan. The lead's other emails, phones and home address are in `lead_keys`.
- `extra` never holds age, income, net worth, marital status or children: we stopped asking Delivr for them on Oct 8, and migration 0013 removed what was stored. Customers get only `provider`, `mock` and `is_homeowner` from it.

Indexed on `(site_id, created_at)` for lead lists and `(site_id, visitor_id, created_at)` for the 30-day rule.

## deliveries

One row per attempt to hand a lead to the customer, one per channel the site has (`email`, `webhook:json`, `webhook:slack`, `webhook:ghl`, or `log` when nothing is set), plus `email:return` for the "they're back" email when a known lead returns (at most one per visitor per 24 hours). `payload` is the exact body sent. `status` is `pending`, `delivered`, `failed` or `skipped`; `skipped` with `last_error = over_quota` means the account was past its monthly limit. `last_error = email_not_configured` means the site has a lead email but email is not set up. `attempts` counts tries; the cron retries `failed` rows younger than 24 hours with back-off, up to 5 tries. Indexed on `status` so the retry job can find failures, and on `created_at` for `/admin`'s delivery health (migration 0014).

## hail_events

One row per reported hail event. `source` plus `external_id` is unique, so re-syncing a feed upserts instead of duplicating. NOAA ids start with `lsr2:` and name the report (office, time, type, place), not the NWS product, so a corrected report replaces the first copy. `lat`, `lng` is the report point; `geom` holds a JSON polygon when a vendor gives a swath. `max_hail_in` is the hail size in inches. `raw` keeps the source record as received. Indexed on `event_at`, `state`, `zip` and `(lat, lng)` so the scorer can bounding-box a search.

In this slice only `MockHailSource` writes here. NOAA and vendors come later.

## lead_scores

One row per scoring run. `visit_id` is required. `lead_id` is NULL for a ZIP-level score taken right after the visit, and set for the address-level score after identification. Both rows stay; the dashboard shows the newest. `components` is a JSON record of every input to the formula (events considered, distances, days since, weights), so the formula can change without losing history. `hail_days_since`, `hail_max_in` and `hail_distance_mi` describe the single best event.

## optouts

People who asked us to stop. Only `email_hash` is kept, never the email. `POST /optout` writes the typed email's hash, plus the hash of every other email we knew for that person (from `lead_keys`). The resolution step checks every email in a match against it, not just the one on the lead.

## optout_keys

Other ways to recognize someone who opted out (migration 0013). `key` is one of:

- `visitor:<site_id>:<visitor_id>`: a browser on one site. Checked right after gate 1, so an opted-out browser is never looked up or billed again.
- `phone:<sha256 of the last 10 digits>` and `addr:<sha256 of last name|street|zip5>`: checked on every match, so a match with no email, or a new email, is still thrown away.

Only hashes and our own random ids. Kept forever, like `optouts`.

## lead_keys

Hashes of every email, phone and home address we know for a lead (migration 0013): `email:<hash>` (same hash as `leads.email_hash`), `phone:…` and `addr:…` as above. Written with the lead in one batch, from the lead's own fields and every email and phone the provider returned. An opt-out with any of the person's emails finds the lead through it. Deleted with the lead.

## optout_recalls

Recall notices waiting to go out (migration 0013). `POST /optout` writes one row per deleted lead, in the same batch as the delete, with just what the business needs to find the person: name, email, city, state, the lead's date and site name. The row is deleted the moment the email is sent. A failed send stays; the 5-minute cron retries it with back-off (attempts² × 5 minutes, up to 20 tries, about 8 days). If email is not set up, the rows wait.

`POST /optout` also deletes every other lead for the same browser on the same site, those leads' deliveries, keys and address-level score rows, and blanks the raw provider answers behind that browser to `{"rows": n, "opted_out": 1}`.

## spend_alerts

Which "Delivr spend crossed X" emails already went out, so each is sent once. `key` is `delivr:month:2026-10:50`, `...:80`, `...:100` (the monthly cap hit) or `delivr:day:2026-10-07:cap`; `sent_at` is when. A failed send deletes its row so the next check tries again. Migration 0011, which also adds `identity_requests(provider, created_at)` for the spend sum. Not customer data.

## rate_limits

Scratch table for the collector's sliding-window limiter. Key is `site:<id>` or `ip:<hash>`, bucket is the minute number. Rows older than two minutes are useless and are deleted by the cron. Not customer data.
