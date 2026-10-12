/**
 * Row types for every table in packages/db/migrations.
 * JSON columns are typed as strings here; use the parse helpers in queries.ts.
 * Timestamps are integer milliseconds since the Unix epoch.
 */

export type Plan = 'trial' | 'starter' | 'pro';
export type AccountStatus = 'active' | 'suspended';

export interface AccountRow {
  id: string;
  name: string;
  email: string;
  plan: Plan;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  monthly_quota: number; // identified households per calendar month; 0 = unlimited
  status: AccountStatus;
  created_at: number;
}

export interface SiteRow {
  id: string;
  account_id: string;
  site_key: string;
  name: string;
  allowed_domains: string; // JSON string[]
  active: number; // 0 | 1
  lead_email: string | null; // where lead cards are emailed; NULL = off
  webhook_url: string | null; // optional webhook; NULL = off
  webhook_kind: WebhookKind | null;
  stripe_session_id: string | null;
  dash_key: string | null; // opens this site's dashboard; secret
  delivr_pixel_id: string | null; // Delivr pixel for this site; NULL = mock provider for this site
  pixel_seen_at: number | null; // last time /p/KEY.js was fetched (migration 0010); NULL = never
  stripe_subscription_id: string | null; // the subscription that pays for this site (migration 0015)
  review_reason: string | null; // why a paid site waits for the operator, off until then (migration 0015); NULL = none
  created_at: number;
}

export type WebhookKind = 'json' | 'slack' | 'ghl';

export interface VisitorRow {
  id: string;
  site_id: string;
  first_seen_at: number;
  last_seen_at: number;
  visit_count: number;
}

export interface DeviceInfo {
  type: 'desktop' | 'phone' | 'tablet' | 'other';
  browser: string;
  os: string;
}

export interface ScreenInfo {
  w: number;
  h: number;
  vw: number;
  vh: number;
  dpr: number;
}

export interface VisitRow {
  id: string;
  site_id: string;
  visitor_id: string;
  session_id: string;
  url: string;
  path: string;
  referrer: string | null;
  title: string | null;
  ip_hash: string;
  ip_raw: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  postal: string | null;
  asn: number | null;
  colo: string | null;
  lat: number | null;
  lng: number | null;
  user_agent: string | null;
  device: string | null; // JSON DeviceInfo
  screen: string | null; // JSON ScreenInfo
  timezone: string | null;
  language: string | null;
  bot_score: number | null;
  time_on_page_ms: number | null;
  occurred_at: number;
  created_at: number;
  resolve_attempted_at: number | null;
  gpc: number; // 0 | 1
  asn_org: string | null;
  asn_class: AsnClass | null;
  skip_reason: string | null;
}

export type AsnClass = 'residential' | 'mobile' | 'business' | 'hosting' | 'relay' | 'unknown';

export type IdentityRequestStatus = 'pending' | 'resolved' | 'no_match' | 'error';

export interface IdentityRequestRow {
  id: string;
  visit_id: string;
  provider: string;
  status: IdentityRequestStatus;
  request_payload: string | null;
  response_payload: string | null;
  cost_cents: number | null;
  created_at: number;
  completed_at: number | null;
}

export interface LeadRow {
  id: string;
  site_id: string;
  visitor_id: string;
  identity_request_id: string;
  first_name: string | null;
  last_name: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone: string | null;
  email: string | null;
  confidence: number | null;
  lat: number | null;
  lng: number | null;
  linkedin_url: string | null;
  email_hash: string | null; // sha256 of the normalized email, for opt-outs
  extra: string; // JSON object
  created_at: number;
}

export type DeliveryStatus = 'pending' | 'delivered' | 'failed' | 'skipped';

export interface DeliveryRow {
  id: string;
  lead_id: string;
  channel: string;
  status: DeliveryStatus;
  attempts: number;
  last_error: string | null;
  payload: string | null;
  created_at: number;
  delivered_at: number | null;
}

export type HailSeverity = 'minor' | 'moderate' | 'severe';

export interface HailEventRow {
  id: string;
  source: string;
  external_id: string;
  event_at: number;
  lat: number;
  lng: number;
  geom: string | null;
  max_hail_in: number;
  severity: HailSeverity | null;
  state: string | null;
  county: string | null;
  zip: string | null;
  raw: string;
  created_at: number;
}

export interface LeadScoreRow {
  id: string;
  lead_id: string | null;
  visit_id: string;
  score: number;
  hail_days_since: number | null;
  hail_max_in: number | null;
  hail_distance_mi: number | null;
  components: string; // JSON
  scored_at: number;
}

/** Fields a provider returns for a person. Mirrors the nullable columns on `leads`. */
export interface LeadFields {
  first_name?: string;
  last_name?: string;
  address_line1?: string;
  address_line2?: string;
  city?: string;
  state?: string;
  zip?: string;
  phone?: string;
  email?: string;
  linkedin_url?: string;
  extra?: Record<string, unknown>;
}
