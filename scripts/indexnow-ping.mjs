#!/usr/bin/env node
/**
 * Tell IndexNow (Bing, and the engines that share its index) which public pages changed.
 *
 *   node scripts/indexnow-ping.mjs [before-sha]
 *
 * Reads apps/collector/src/public-pages.json at HEAD and at `before-sha` (the commit that was
 * live before this deploy) and pings every URL whose `updated` date changed or that is new.
 * With no usable `before-sha` it pings every page. Needs INDEXNOW_KEY in the environment;
 * without it the script says so and exits 0.
 *
 * This never fails the deploy: every path ends in exit code 0.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const HOST = process.env.INDEXNOW_HOST || 'tryyardsign.com';
const ENDPOINT = process.env.INDEXNOW_ENDPOINT || 'https://api.indexnow.org/indexnow';
const FILE = 'apps/collector/src/public-pages.json';
const KEY_RE = /^[A-Za-z0-9-]{8,128}$/;

/** Map of path -> updated for a page list. */
function lastmods(pages) {
  return new Map(pages.map((p) => [p.path, p.updated]));
}

/** Pages whose `updated` changed since `previous`, or every page when `previous` is null. */
function changedPages(current, previous) {
  if (!previous) return current;
  const before = lastmods(previous);
  return current.filter((p) => before.get(p.path) !== p.updated);
}

function previousPages(sha) {
  if (!sha || /^0+$/.test(sha)) return null;
  try {
    try {
      execFileSync('git', ['fetch', '-q', '--depth=1', 'origin', sha], { stdio: 'ignore' });
    } catch {
      // Already present, or not fetchable. git show below decides.
    }
    return JSON.parse(execFileSync('git', ['show', `${sha}:${FILE}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    console.log(`indexnow: could not read ${FILE} at ${sha}; pinging every page`);
    return null;
  }
}

async function main() {
  const key = (process.env.INDEXNOW_KEY || '').trim();
  if (!KEY_RE.test(key)) {
    console.log('indexnow: INDEXNOW_KEY is not set (or not 8-128 letters, digits and dashes); skipping');
    return;
  }
  const current = JSON.parse(readFileSync(FILE, 'utf8'));
  const changed = changedPages(current, previousPages(process.argv[2]));
  if (changed.length === 0) {
    console.log('indexnow: no page dates changed; nothing to ping');
    return;
  }
  const urlList = changed.map((p) => `https://${HOST}${p.path}`);
  const body = { host: HOST, key, keyLocation: `https://${HOST}/${key}.txt`, urlList };
  const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) });
  const text = (await res.text()).trim();
  console.log(`indexnow: ${res.status} for ${urlList.length} url(s): ${urlList.join(', ')}${text ? ` (${text})` : ''}`);
  if (!res.ok) console.log('indexnow: the ping failed; the deploy is unaffected');
}

main().catch((err) => console.log(`indexnow: ping failed (${err instanceof Error ? err.message : String(err)}); the deploy is unaffected`));
