# Delivr: what we learned before writing the adapter (Oct 5)

Plain facts from Delivr's public docs and pricing page. Read this before touching
`packages/identity/src/delivr.ts`. Links at the bottom.

> The GitHub Actions workflows mentioned below (Delivr setup, probe, events) were operational
> tools for the live deployment and are not included in this public copy.

## How Delivr works (it is not what we assumed)

- Delivr **never resolves an IP address to a person.** Their docs say so outright.
- Resolution happens through **their pixel and their cookie.** Their script runs in the
  visitor's browser, sets a Delivr cookie, and syncs it with partner cookies. Delivr matches
  that cookie against their identity graph. Resolved visits then show up as **events** you
  query from their API by pixel id and time window.
- There is also a server-to-server "send event" call that returns a Delivr `cookie_id` and
  cookie-sync redirect URLs. It still needs the browser to follow those redirects for a match
  to be likely.
- Visitors from the EU, UK and Switzerland are never resolved. Visitors sending the Global
  Privacy Control header are never resolved. Safari and iPhone resolve less often because
  their cookies expire in 7 days.
- The "lookup" endpoint takes an **email** (plain or hashed), not an IP, and returns
  **work and company fields.** The docs say it does not return a home address, personal
  phone or personal email.

## The fit question: answered yes (Oct 5)

The probe workflow called the full-profile schema with the owner's key. The tier carries
**homeowner fields**, not just work data:

- `first_name`, `middle_name`, `last_name`
- `personal_address`, `personal_address_2`, `personal_city`, `personal_state`,
  `personal_state_code`, `personal_zip`, `personal_zip4`, `dpv_code` (USPS delivery-point check)
- `personal_phones`, `mobile_phones`, `phones` (lists), plus `*_dnc` lists for do-not-call
- `personal_email`, `personal_emails`, `email`, `emails`
- `is_homeowner`, `is_married`, `has_children`, `age_range`, `income_range_lc`, `net_worth`
- `is_profile_b2c` / `is_profile_b2b`, and the work fields (`job_title`, `company_*`)
- per-event: `event_id`, `event_type`, `timestamp`, `ip`, `client_ip`, `user_agent`,
  `click_url`, `referrer_url`, `cookie_id`, `uuid`, `pixel_id`, `resolved`, `event_data`, `extra_json`

Account facts from `whoami`: organization "Yardsign", one project named "Yardsign"
(project id `00000000-0000-0000-0000-000000000001`). Billing usage for October: 0.

## What makes it paid

- A **dev key** is free and runs against **sample data only.** You cannot resolve a real
  visitor on it.
- A **production key** is pay-per-use. There is no monthly minimum, no setup fee and no
  contract. Billing is monthly, in arrears. The API page says a payment card goes on file
  before production use.
- You are charged **per row returned.** A no-match (HTTP 404) is free. Previews return up to
  25 rows free. A dry run tells you the billable count before a real call, free.
- Meters that matter to us (first band is the cheapest-to-start; rates fall with volume):

| Meter | First 10,000 per month | Then |
|---|---|---|
| Resolutions: full profile (name + contact + company) | $25 per 1,000 | $10 per 1,000 to 50k, then $6 |
| Resolutions: HEM + email | $12 per 1,000 | $6, then $3 |
| Resolutions: HEM only (hashed email) | $6 per 1,000 | $3, then $0.50 |
| Contact record (the email lookup endpoint) | $10 per 1,000 | $5, then $2.50 |
| Web events (one captured page view or click) | $0.05 per 1,000 (first 1M) | $0.02, then $0.01 |

So: **the first real resolution on a production key starts the bill.** At our scale it is
tiny. 1,000 full-profile matches a month is $25. 100,000 page views is $5.

The $25k to $60k a year numbers you may see on review sites are Delivr's managed
enterprise platform (sales call, annual contract, onboarding fee). The self-serve API above is
a different door and is the one we use.

## Keys

- One **key + secret pair** per organization, made at Delivr → Settings → API keys. Every
  call sends both: `X-Api-Key` (starts with `dlvr_`) and `X-Api-Secret`.
- GitHub secrets: `DELIVR_API_KEY` and `DELIVR_API_SECRET`. The deploy syncs both to the
  Worker when they are set.

## The adapter (built Oct 5, `packages/identity/src/delivr.ts`)

1. **One Delivr pixel per site.** `sites.delivr_pixel_id` holds it. The founder's site has one
   (migration 0009). Set or clear one with `PUT /api/admin/sites/:key/delivr` body `{"pixel_id": "..."}`.
   Make the pixel itself with the GitHub workflow "Delivr setup" (create_pixel = true).
2. **Our pixel loads theirs.** When the site has a pixel id, the served `/p/KEY.js` appends
   Delivr's script with `data-global-params` = `{ys_vid, ys_key}`. Delivr copies global params
   into every event's `event_data`, so each of their events carries our visitor id. Since Oct 7,
   2026 the Worker puts the pixel id into the file only when gate 1 in `src/policy.ts` passes:
   US, no `Sec-GPC: 1`, not a known bot, and not a visit from a known state outside Texas
   (`ALLOWED_STATES`). Since Oct 8 a visit with an unknown region passes, and so does a
   data-center network (iCloud Private Relay, Cloudflare WARP, Google Fi, office VPNs). The
   file is `Cache-Control: private`, its ETag and the `X-Yardsign-Gate` header carry the gate
   answer, and the browser still checks `navigator.globalPrivacyControl`. Before a match is
   delivered, gate 2 must pass: the person's home address is in Texas, or the visit came from
   Texas (Oct 8). Sites without a pixel id load nothing extra.
3. **The resolution step asks per visit.** With `IDENTITY_PROVIDER = "delivr"`, a site with a
   pixel id gets `DelivrProvider`; a site without one keeps the mock (its cards carry the TEST
   banner). The provider waits until the visit is 10 minutes old (Delivr's events lag the page
   view), then queries `GET /api/v3/events/resolution_full_profile` for that pixel, a window of
   15 minutes before to 2 hours after the visit, `filter=event_data:like:<our visitor id>,resolved:eq:true`,
   `limit=1`, and a `select` of the fields we map. The visitor id is the join key: our pixel puts it
   into every Delivr event's `event_data`, and Delivr's `like` with no wildcard is a substring match
   (tested on the live API Oct 7; `%` and `*` wildcards match nothing, a comma joins conditions, a
   semicolon does not, and rows come back oldest first). The IP is only a fallback: the first real
   iPhone visit reached our collector over IPv6 while Delivr recorded it under IPv4, so an IP filter
   missed it. `resolved:eq:true` means only a matched person can come back, so a no-match is free. Every name in that `select` must exist in the live schema:
   the production API rejects the whole query (HTTP 400 "Schema error") on one unknown name,
   while the dev key accepted anything. That is how `click_url` slipped in and made the first
   two real calls on Oct 7 fail. The "Probe the Delivr account" workflow prints the live schema.
   In that schema the phone and email lists and the true/false flags are typed as text, so the
   adapter reads arrays, JSON-as-text and comma-separated strings alike. A row counts only if its `ip` or `client_ip` equals the visit's
   IP, or its `event_data` contains our visitor id.
4. **Mapping.** `personal_address` → address, `personal_city`, `personal_state_code`,
   `personal_zip`; phone = first mobile not on the do-not-call list, then personal, then any;
   email = personal first, business last. `is_homeowner`, `dpv_code`, age, income, net worth and
   zip+4 ride in `leads.extra`. Confidence (Oct 7) comes from what came back, since Delivr gives
   no match score: email only 0.3; a name with an email or phone but no street 0.5; a name and a
   street address 0.7. Then +0.1 for a USPS-checked street address, +0.05 for the homeowner flag,
   +0.05 for a phone, capped at 0.95. The resolution step then checks location
   (`apps/collector/src/confidence.ts`) and drops anything under `MIN_CONFIDENCE` (0.2).
5. **Breaker.** Every row returned costs 2.5 cents (first band). Empty results are free. If
   three calls in a row return rows that do not belong to the visit (the sign of a filter that
   was ignored), the provider stops calling for the rest of that poll run and records an error
   on each remaining visit. The cost is written to `identity_requests.cost_cents` (rounded up
   to 3). The rest of the bill protection is the next section.

## Bill protection (added Oct 7, before the production key)

The owner's worry: bots running up the Delivr bill. Six guards, all in code, all on by default.
The spend guard lives in `apps/collector/src/spend.ts`; the resolution step calls it only for a
paid provider (one whose `maxCostCentsPerCall` is set). The mock is free and skips all of it.

1. **Monthly hard cap.** `DELIVR_MONTHLY_CAP_CENTS` in `wrangler.toml`, default `125000`
   ($1,250). Before every Delivr call the step adds up `identity_requests.cost_cents` for
   provider `delivr` since 00:00 UTC on the 1st (Delivr's bands reset then too). If spent plus
   the worst case for this call (row limit × 2.5 cents) would cross the cap, the call is not
   made. The visit is marked `skip_reason = spend_cap`. No lead, no charge. Nothing restarts
   until the 1st, or until the cap is raised and deployed.
2. **Daily safety cap.** `DELIVR_DAILY_CAP_CENTS`, default `1000` ($10, about 400 full-profile rows; lowered from $100 on Oct 7 at the owner's request). Same check since
   00:00 UTC today, `skip_reason = daily_spend_cap`. A bot surge cannot burn the month in an
   afternoon. Resets at midnight UTC.
3. **Fail closed.** If the spend query itself fails, the call is not made and the visit is
   marked `spend_check_error`. The guard can only ever say no.
4. **Only people.** *(Off since Oct 8: `DELIVR_ENGAGEMENT_GATE` in `wrangler.toml` is "off", and the pixel loads Delivr's script right after the page view. Delivr matches on the first event or never, and a no-match is free. Set the var to "on" to bring the gate back. What follows is how it works when on.)* Delivr is asked about a visit only when the session showed a human signal:
   two or more page views, or ten seconds on one page (the unload beacon). A lone fresh page
   view waits up to 30 minutes for the second view or the beacon, then is skipped as
   `no_engagement`. 30 minutes sits well inside Delivr's 2-hour query window and our 72-hour
   raw-IP retention. On the browser side, our pixel loads Delivr's script only after a scroll, a
   pointer or touch, or five seconds with the tab visible, and never when `navigator.webdriver`
   is set or the screen is 0×0 (no beacon either). Bots never cost a web event.
5. **Fewer rows.** `limit=1` per call (was 3); we only ever used the first resolved row. And one
   billed Delivr call or match per visitor per site per 24 hours (`skip_reason = deduped_24h`). A lookup that died mid-call (pending over 10 minutes) counts as billed. The claim before each call (`claimIdentityRequest`, see `docs/ARCHITECTURE.md`) makes this hold even when two runs overlap.
   Since Oct 8 a free miss does not count: Delivr usually matches a browser on its second visit,
   so when the visitor comes back, we ask again. The 30-day rule still applies on top, and it
   also counts only leads, matches and billed calls. Both rules are per provider, so a mock
   answer never blocks a real lookup.
6. **Alerts.** Email to `SPEND_ALERT_EMAIL` (`wrangler.toml`, set to `alerts@example.com`,
   which forwards to the owner's inbox) when month-to-date spend crosses 50% and 80% of the monthly
   cap, when the monthly cap stops a call, and when the daily cap stops one. Each goes once per
   month (once per day for the daily one); the `spend_alerts` table remembers what was sent, and
   a failed send is retried next time. Uses the same Resend sender as lead cards. Without
   `EMAIL_API_KEY` or `SPEND_ALERT_EMAIL`, the alert is written to the Worker log at error level
   instead, still once.

Spend is counted at the first-band rate, so the number runs high. Delivr's invoice is the truth.
The admin page's "Why skipped" breakdown and its visit list show every one of these skip reasons by name.

**Settled on the first production run (Oct 7):** the filter shape is `<field>:<op>:<value>` with
operators `eq, ne, gt, gte, lt, lte, like, in, notin, not_null, is_null`; `like` is a plain substring
match; a comma joins conditions. `event_data` is JSON text in real rows and carries our
`ys_vid`. The "Delivr events for a pixel" workflow (Actions tab) takes a `filter` input for trying
any of this against the cheap web_event tier. The dev key returned the same two sample people
for every query, which is why none of this showed up before the production key.

**New sites get a pixel on their own.** `apps/collector/src/delivr-pixel.ts` creates one right
after the site row (Stripe checkout and `POST /api/admin/sites`), in the project named by
`DELIVR_PROJECT_ID`. If Delivr is down the site is still created and stays on the mock provider
until someone sets a pixel with the admin route.

## Links

- API overview and pricing: https://www.delivr.ai/api and https://www.delivr.ai/pricing
- Docs: https://docs.delivr.ai/docs/delivr-apis and https://docs.delivr.ai/reference
- How resolution works: https://docs.delivr.ai/docs/how-identity-resolution-works
- Pixel setup: https://support.delivr.ai/articles/9922301-delivr-new-pixel-setup-guide
