import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { SITE_ID } from './helpers';

/** Migration 0012 removes the mock provider's fake leads and leaves real (Delivr) rows alone. */
const wipe = env.TEST_MIGRATIONS.find((m) => m.name.startsWith('0012_'));

async function seed(tag: string, provider: 'mock' | 'delivr'): Promise<void> {
  const t = Date.now();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO visits (id, site_id, visitor_id, session_id, url, path, ip_hash, occurred_at, created_at) VALUES (?, ?, ?, 's', 'http://localhost/', '/', 'h', ?, ?)`).bind(`v_${tag}`, SITE_ID, `vid_${tag}`, t, t),
    env.DB.prepare(`INSERT INTO identity_requests (id, visit_id, provider, status, created_at) VALUES (?, ?, ?, 'resolved', ?)`).bind(`r_${tag}`, `v_${tag}`, provider, t),
    env.DB.prepare(`INSERT INTO leads (id, site_id, visitor_id, identity_request_id, first_name, created_at) VALUES (?, ?, ?, ?, 'Pat', ?)`).bind(`l_${tag}`, SITE_ID, `vid_${tag}`, `r_${tag}`, t),
    env.DB.prepare(`INSERT INTO deliveries (id, lead_id, channel, status, created_at) VALUES (?, ?, 'email', 'delivered', ?)`).bind(`d_${tag}`, `l_${tag}`, t),
    env.DB.prepare(`INSERT INTO lead_scores (id, lead_id, visit_id, score, scored_at) VALUES (?, ?, ?, 50, ?)`).bind(`s_${tag}`, `l_${tag}`, `v_${tag}`, t),
    env.DB.prepare(`INSERT INTO lead_scores (id, lead_id, visit_id, score, scored_at) VALUES (?, NULL, ?, 40, ?)`).bind(`z_${tag}`, `v_${tag}`, t),
  ]);
}

const ids = async (table: string): Promise<string[]> => (await env.DB.prepare(`SELECT id FROM ${table} ORDER BY id`).all<{ id: string }>()).results.map((r) => r.id);

describe('migration 0012: wipe mock leads', () => {
  it('deletes mock leads with their lookups, deliveries and lead scores; keeps Delivr rows and every visit', async () => {
    expect(wipe).toBeDefined();
    await seed('fake', 'mock');
    await seed('real', 'delivr');

    for (const sql of wipe!.queries) await env.DB.prepare(sql).run();

    expect(await ids('leads')).toEqual(['l_real']);
    expect(await ids('identity_requests')).toEqual(['r_real']);
    expect(await ids('deliveries')).toEqual(['d_real']);
    expect(await ids('lead_scores')).toEqual(['s_real', 'z_fake', 'z_real']);
    expect(await ids('visits')).toEqual(['v_fake', 'v_real']);
  });
});
