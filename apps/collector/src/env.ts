import type { ResolveMessage } from './scheduler';

/** Bindings and vars for the collector Worker. Secrets are optional at the type level so a missing one fails loudly at runtime, not at build. */
export interface Env {
  DB: D1Database;
  /** Present only when the queue blocks in wrangler.toml are uncommented. */
  RESOLVE_QUEUE?: Queue<ResolveMessage>;
  ADMIN_TOKEN?: string;
  IP_SALT?: string;
  IDENTITY_PROVIDER?: string;
  DELIVR_API_KEY?: string;
  DELIVR_API_SECRET?: string;
  /** The Delivr project new pixels go in. Public id. */
  DELIVR_PROJECT_ID?: string;
  /** Hard stop on Delivr spend per calendar month (UTC), in cents. Default 125000 ($1,250). "0" stops every paid call. Counted at the first-band rate. */
  DELIVR_MONTHLY_CAP_CENTS?: string;
  /** Hard stop on Delivr spend per UTC day, in cents. Default 1000 ($10, about 400 rows). "0" stops every paid call. A bot surge cannot burn the month in an afternoon. */
  DELIVR_DAILY_CAP_CENTS?: string;
  /** "on" = ask Delivr only after a human signal (2+ views or 10 s on a page). Unset or "off" = ask after every page view. A no-match is free and the caps still apply. */
  DELIVR_ENGAGEMENT_GATE?: string;
  /** Who gets the "spend at 50% / 80% / cap hit" emails. Unset = those alerts are logged at error level only. */
  SPEND_ALERT_EMAIL?: string;
  PUBLIC_BASE_URL?: string;
  BUILD_SHA?: string;
  RATE_LIMIT_SITE_PER_MIN?: string;
  RATE_LIMIT_IP_PER_MIN?: string;
  /** Where hail reports come from: "noaa" (NWS storm reports) or "mock" (fake DFW events). Default "mock". */
  HAIL_SOURCE?: string;
  /** Turns lead addresses into map points for hail distance: "census" (default) or "none". */
  GEOCODER?: string;
  /**
   * Tests only: a comma list that replaces ALLOWED_STATES in src/policy.ts (e.g. "TX,OK").
   * Leave unset in wrangler.toml; to add a state for real, change ALLOWED_STATES in the code.
   */
  ALLOWED_STATES?: string;
  /** Days after the first lookup during which an email-only match or a miss may be looked up again on a return visit. Default 7. */
  RECHECK_DAYS?: string;
  /** Matches scoring below this (0 to 1) after the location check never become leads. Default 0.2. */
  MIN_CONFIDENCE?: string;
  /** "resend" or "postmark". Unset = lead cards go to the log only. */
  EMAIL_PROVIDER?: string;
  EMAIL_API_KEY?: string;
  /** e.g. "Yardsign <leads@tryyardsign.com>" */
  EMAIL_FROM?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_STARTER?: string;
  STRIPE_PRICE_PRO?: string;
  /** Cloudflare Access team domain for /admin, e.g. "yardsign" or "yardsign.cloudflareaccess.com". Unset = /admin refuses everyone. */
  CF_ACCESS_TEAM_DOMAIN?: string;
  /** The Access application's audience (AUD) tag. Unset = /admin refuses everyone. */
  CF_ACCESS_AUD?: string;
  /** IndexNow key (public by design). Served at /<key>.txt. Unset = no key file, no pings. */
  INDEXNOW_KEY?: string;
}

export function intVar(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Like intVar, but "0" is a real value: a spend cap of 0 means no paid calls. Missing, blank or junk gives the fallback. */
export function capVar(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}
