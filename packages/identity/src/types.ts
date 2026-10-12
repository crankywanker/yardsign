import type { LeadFields } from '@yardsign/db';

export type { LeadFields };

/** Everything a provider may use to resolve one visit to a household. */
export interface ResolveInput {
  visitor_id: string;
  visit_id: string;
  site_id: string;
  /** Raw IP, only while we still have it (72 hours). Null after that. */
  ip: string | null;
  ip_hash: string;
  user_agent: string | null;
  geo: {
    country: string | null;
    region: string | null;
    city: string | null;
    postal: string | null;
    lat: number | null;
    lng: number | null;
    asn: number | null;
  };
  /** The browser's clock. It can be off by minutes or hours; never use it for anything that matters. */
  occurred_at: number;
  /** Our server's clock when the visit arrived. Search windows are built from this. */
  created_at: number;
  /** The site's id at the provider, when the provider needs one (Delivr: the site's pixel id). */
  provider_site_id?: string | null;
}

export type ResolveStatus = 'resolved' | 'no_match' | 'error';

export interface ResolveResult {
  status: ResolveStatus;
  lead?: LeadFields;
  /** 0..1 */
  confidence?: number;
  /** The provider's response, stored as-is in identity_requests.response_payload. */
  raw?: unknown;
  /** Every email and phone the provider returned for this person, not just the ones on the lead. The opt-out check uses them all. */
  emails?: string[];
  phones?: string[];
  cost_cents?: number;
  /** Set on 'error'. */
  error?: string;
}

export interface IdentityProvider {
  readonly name: string;
  /** Do not ask about a visit younger than this; the provider's data lags the page view. */
  readonly minVisitAgeMs?: number;
  /**
   * The most one call can bill, in cents. Unset or 0 means the provider is free (the mock), and
   * the bill protections in the resolution step (spend caps, engagement gate, 24-hour rule) do not run.
   */
  readonly maxCostCentsPerCall?: number;
  resolve(input: ResolveInput): Promise<ResolveResult>;
}
