export * from './types';
export { MockProvider, MOCK_RESOLVE_PERCENT, MOCK_COST_CENTS, fnv1a } from './mock';
export { DelivrProvider, DELIVR_COST_CENTS, DELIVR_SELECT, DELIVR_MIN_VISIT_AGE_MS, DELIVR_ROW_LIMIT, DELIVR_MAX_COST_CENTS_PER_CALL, DELIVR_MISMATCH_TRIP, mapDelivrRow, pickPhone, pickEmail, allEmails, allPhones, rowMatchesVisit, list as delivrList, bool as delivrBool, type DelivrEventRow, type DelivrOptions } from './delivr';

import { DelivrProvider } from './delivr';
import { MockProvider } from './mock';
import type { IdentityProvider } from './types';

export interface ProviderEnv {
  IDENTITY_PROVIDER?: string;
  DELIVR_API_KEY?: string;
  DELIVR_API_SECRET?: string;
}

/** What getProvider needs to know about the site: Delivr works per pixel, and a site without one stays on mock. */
export interface ProviderSite {
  delivrPixelId?: string | null;
}

/**
 * Pick the provider from env, and the site. Default is "mock". Unknown names throw so a typo cannot
 * silently fall back. With IDENTITY_PROVIDER = "delivr", a site that has no Delivr pixel id still gets
 * the mock provider: its cards carry the loud TEST banner, and nothing is billed for it.
 */
export function getProvider(env: ProviderEnv, site?: ProviderSite): IdentityProvider {
  const name = (env.IDENTITY_PROVIDER ?? 'mock').toLowerCase();
  switch (name) {
    case 'mock':
      return new MockProvider();
    case 'delivr':
      if (site && !site.delivrPixelId) return new MockProvider();
      return new DelivrProvider({ apiKey: env.DELIVR_API_KEY, apiSecret: env.DELIVR_API_SECRET });
    default:
      throw new Error(`Unknown IDENTITY_PROVIDER "${name}" (expected "mock" or "delivr")`);
  }
}
