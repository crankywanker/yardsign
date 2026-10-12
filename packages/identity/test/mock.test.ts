import { describe, expect, it } from 'vitest';
import { DelivrProvider, MOCK_RESOLVE_PERCENT, MockProvider, getProvider, type ResolveInput } from '../src';

function input(visitorId: string): ResolveInput {
  return {
    visitor_id: visitorId,
    visit_id: 'v1',
    site_id: 's1',
    ip: '203.0.113.5',
    ip_hash: 'abc',
    user_agent: 'Mozilla/5.0',
    geo: { country: 'US', region: 'TX', city: 'Plano', postal: '75024', lat: 33.0, lng: -96.7, asn: 7018 },
    occurred_at: 1,
    created_at: 1,
  };
}

/** Deterministic UUID-shaped ids for the tests. */
function vid(n: number, suffix = '00'): string {
  const hex = n.toString(16).padStart(8, '0');
  return `${hex}-0000-4000-8000-0000000000${suffix}`;
}

describe('MockProvider', () => {
  const p = new MockProvider();

  it('is deterministic for the same visitor id', async () => {
    const a = await p.resolve(input(vid(7)));
    const b = await p.resolve(input(vid(7)));
    expect(a).toEqual(b);
  });

  it('resolves roughly 35% of visitors', async () => {
    let resolved = 0;
    const n = 2000;
    for (let i = 0; i < n; i++) {
      const r = await p.resolve(input(vid(i, '00')));
      if (r.status === 'resolved') resolved++;
    }
    const pct = (resolved / n) * 100;
    expect(pct).toBeGreaterThan(MOCK_RESOLVE_PERCENT - 6);
    expect(pct).toBeLessThan(MOCK_RESOLVE_PERCENT + 6);
  });

  it('returns error for a visitor id ending in ff', async () => {
    const r = await p.resolve(input(vid(3, 'ff')));
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/simulated/);
  });

  it('returns obviously fake Texas data', async () => {
    let found = false;
    for (let i = 0; i < 200 && !found; i++) {
      const r = await p.resolve(input(vid(i)));
      if (r.status !== 'resolved') continue;
      found = true;
      expect(r.lead?.state).toBe('TX');
      expect(r.lead?.phone).toMatch(/^\(\d{3}\) 555-01\d{2}$/);
      expect(r.lead?.email).toMatch(/@example\.com$/);
      expect(r.lead?.address_line1).toMatch(/Example|Sample|Placeholder|Test|Demo|Mockingbird/);
      expect(r.confidence).toBeGreaterThanOrEqual(0.6);
      expect(r.confidence).toBeLessThanOrEqual(0.95);
      expect(r.cost_cents).toBeGreaterThan(0);
    }
    expect(found).toBe(true);
  });
});

describe('getProvider', () => {
  it('defaults to mock', () => {
    expect(getProvider({}).name).toBe('mock');
  });
  it('throws on an unknown provider name', () => {
    expect(() => getProvider({ IDENTITY_PROVIDER: 'nope' })).toThrow(/Unknown IDENTITY_PROVIDER/);
  });
  it('delivr throws until configured', async () => {
    const p = getProvider({ IDENTITY_PROVIDER: 'delivr' });
    expect(p).toBeInstanceOf(DelivrProvider);
    await expect(p.resolve(input(vid(1)))).rejects.toThrow('Delivr provider not configured');
  });
});
