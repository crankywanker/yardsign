# Yardsign

Website visitor identification for home-service contractors (roofers first).

A contractor pastes one script tag on their website. Yardsign records the visit, asks an identity-data vendor which household the browser belongs to, checks the address against recent hail reports, scores the lead, and sends a lead card to the contractor by email or webhook (GoHighLevel, Slack, Zapier).

**Status: discontinued (October 2026).** This repo is a public snapshot of a two-week build, shared so others can see how it worked and what we learned. The live site no longer identifies anyone. The original work happened in a private repo over about 170 commits, Oct 1 to Oct 12, 2026.

## Why it stopped

The software worked. The data underneath it did not hold up for this use case. On our own test site, over about 40 real visitors:

| What we measured | Result |
|---|---|
| Browsers matched to a person (Chrome/Edge) | about 35% |
| Browsers matched to a person (Safari/iPhone) | 0% |
| Browsers matched overall | about 17% |
| First-time visitors matched | 0% |
| Unique named people, excluding our own testing | 2 |

Homeowners looking for a roofer mostly visit once, and many use iPhones. Those are exactly the visits that did not resolve. Matches also came back at the household level, so a visit could be tied to the wrong person in the home. That is not good enough to hand a contractor a name, address and phone number.

If you build in this space, the lesson we would pass on: first-party capture (a form, a quote tool, a chat) beats third-party identity resolution for consumer traffic.

## What is here

| Where | What |
|---|---|
| `apps/collector` | One Cloudflare Worker: landing page, pixel route, collector, resolution step, lead delivery (email, webhook), customer dashboard, Stripe checkout, legal pages, cron jobs. |
| `packages/pixel` | The browser snippet, built to one file under 4 KB. |
| `packages/db` | D1 (SQLite) migrations, row types, query helpers. |
| `packages/identity` | The `IdentityProvider` interface, a mock provider, and the Delivr.ai adapter. |
| `packages/scoring` | Hail events (NOAA storm reports), geocoding, and the lead score. |
| `docs/` | `ARCHITECTURE.md` (how it flows), `SCHEMA.md` (what the tables mean), `DELIVR.md` (the identity vendor integration and its spend guards). |

Some things worth a look:

- **Privacy gates** (`apps/collector/src/policy.ts`): Global Privacy Control honored, state allow-list, bot filtering, opt-outs that stick across email, phone and address.
- **Spend guards** (`apps/collector/src/spend.ts`): hard daily and monthly caps checked before every paid lookup, with alerts.
- **Hail scoring** (`packages/scoring`): free NOAA storm reports and Census geocoding, distance measured from the house.

## Run it locally

Needs Node 22 and npm.

```
npm install
cp apps/collector/.dev.vars.example apps/collector/.dev.vars
npm run migrate               # applies packages/db/migrations to the local D1
npm run dev                   # builds the pixel, then wrangler dev on http://localhost:8787
```

`npm install` uses `legacy-peer-deps` (set in `.npmrc`) because the Workers test pool pins a Vitest major that npm's resolver trips over.

The identity provider defaults to `mock`, which makes up fake people, so everything runs without any vendor account. The seed migration creates a test site with site key `TESTKEY`, allowed on `localhost`.

```
curl http://localhost:8787/health
curl http://localhost:8787/p/TESTKEY.js | head -c 300
npm run smoke                 # sample visit, resolution step, prints the stored visits
```

## Tests

```
npm test                      # pixel, identity, scoring, collector
npm run typecheck
```

The collector tests run inside the Workers runtime (Miniflare) with a real D1 and the migrations applied.

## Deploying your own copy

This snapshot does not deploy anywhere. To run your own:

1. Create a D1 database and put its id in `apps/collector/wrangler.toml` (`database_id`).
2. Uncomment the `[[routes]]` blocks and set your domain, plus `PUBLIC_BASE_URL`.
3. Set secrets with `wrangler secret put` (the list is at the bottom of `wrangler.toml`).
4. Before using real identity data, talk to a privacy lawyer. Website visitor identification carries real legal risk (state data broker laws, wiretap and pen-register claims).

## License

MIT. See `LICENSE`.
