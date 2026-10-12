/**
 * Countries we never store a visit from. EU (27) + EEA (Iceland, Liechtenstein,
 * Norway) + United Kingdom + Switzerland. ISO 3166-1 alpha-2, as request.cf.country gives it.
 * Keep this the only list; everything else imports it.
 */
export const BLOCKED_COUNTRIES: ReadonlySet<string> = new Set([
  // EU
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  // EEA (non-EU)
  'IS', 'LI', 'NO',
  // UK and Switzerland
  'GB', 'CH',
]);

export function isGeoBlocked(country: string | null | undefined): boolean {
  if (!country) return false;
  return BLOCKED_COUNTRIES.has(country.toUpperCase());
}
