import type { IdentityProvider, ResolveInput, ResolveResult } from './types';

/**
 * Deterministic fake people. The same visitor_id always maps to the same person,
 * so the pipeline behaves like production across repeated visits.
 *
 * - about 35% of visitors resolve
 * - a visitor_id ending in "ff" returns 'error' so the error path gets exercised
 * - everything is obviously fake: 555-01xx phones, example.com emails, "Example Ln" streets
 */
const FIRST = ['Maria', 'James', 'Linda', 'Robert', 'Angela', 'David', 'Karen', 'Michael', 'Patricia', 'Daniel', 'Teresa', 'Chris', 'Rosa', 'Kevin', 'Diane', 'Luis'];
const LAST = ['Garcia', 'Nguyen', 'Johnson', 'Patel', 'Williams', 'Brown', 'Martinez', 'Davis', 'Hernandez', 'Lee', 'Wilson', 'Taylor', 'Moore', 'Flores', 'Clark', 'Ramirez'];
const STREET = ['Example Ln', 'Sample Dr', 'Placeholder Ct', 'Test Trail', 'Demo Way', 'Mockingbird Example Rd'];
const CITY: ReadonlyArray<{ city: string; zip: string; area: string }> = [
  { city: 'Plano', zip: '75024', area: '972' },
  { city: 'Frisco', zip: '75034', area: '469' },
  { city: 'Arlington', zip: '76010', area: '817' },
  { city: 'Fort Worth', zip: '76107', area: '817' },
  { city: 'Dallas', zip: '75230', area: '214' },
  { city: 'Denton', zip: '76201', area: '940' },
  { city: 'McKinney', zip: '75070', area: '469' },
  { city: 'Denton', zip: '76201', area: '940' },
  { city: 'Garland', zip: '75040', area: '972' },
  { city: 'Irving', zip: '75038', area: '214' },
];

export const MOCK_RESOLVE_PERCENT = 35;
export const MOCK_COST_CENTS = { resolved: 25, no_match: 5 } as const;

/** FNV-1a 32-bit. Small, fast, stable across runtimes. */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function pick<T>(list: ReadonlyArray<T>, n: number): T {
  const item = list[n % list.length];
  if (item === undefined) throw new Error('empty list');
  return item;
}

export class MockProvider implements IdentityProvider {
  readonly name = 'mock';

  async resolve(input: ResolveInput): Promise<ResolveResult> {
    const vid = input.visitor_id.toLowerCase();
    if (vid.endsWith('ff')) {
      return { status: 'error', error: 'mock provider: simulated upstream failure', raw: { mock: true, simulated: 'error' } };
    }
    const h = fnv1a(vid);
    if (h % 100 >= MOCK_RESOLVE_PERCENT) {
      return { status: 'no_match', cost_cents: MOCK_COST_CENTS.no_match, raw: { mock: true, roll: h % 100 } };
    }
    const first = pick(FIRST, h >>> 4);
    const last = pick(LAST, h >>> 8);
    const street = pick(STREET, h >>> 12);
    const place = pick(CITY, h >>> 16);
    const houseNumber = 100 + ((h >>> 20) % 8900);
    const line = String(100 + ((h >>> 7) % 100)).slice(-2); // 555-0100 .. 555-0199 is the reserved fictional block
    const confidence = Math.round((0.6 + ((h >>> 3) % 36) / 100) * 100) / 100; // 0.60 .. 0.95
    return {
      status: 'resolved',
      confidence,
      cost_cents: MOCK_COST_CENTS.resolved,
      lead: {
        first_name: first,
        last_name: last,
        address_line1: `${houseNumber} ${street}`,
        city: place.city,
        state: 'TX',
        zip: place.zip,
        phone: `(${place.area}) 555-01${line}`,
        email: `${first}.${last}@example.com`.toLowerCase(),
        extra: { mock: true },
      },
      raw: { mock: true, roll: h % 100 },
    };
  }
}
