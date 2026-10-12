/**
 * Sliding-window rate limiter in D1. Two one-minute buckets per key: the current
 * bucket's count plus the previous bucket's count weighted by how much of the
 * current minute is left. One upsert and one read per check.
 */
export const RATE_WINDOW_MS = 60_000;
export const HOUR_MS = 3_600_000;
/** Keys counted per hour (checkRateLimit with windowMs = HOUR_MS) start with this, so the cron keeps their buckets long enough. */
export const HOURLY_KEY_PREFIX = 'hourly:';

export interface RateLimitResult {
  allowed: boolean;
  /** Estimated hits in the trailing window, including this one. */
  estimate: number;
}

export async function checkRateLimit(
  db: D1Database,
  key: string,
  limit: number,
  now = Date.now(),
  windowMs = RATE_WINDOW_MS,
): Promise<RateLimitResult> {
  const bucket = Math.floor(now / windowMs);
  const elapsed = (now % windowMs) / windowMs;
  const [, read] = await db.batch<{ bucket: number; count: number }>([
    db
      .prepare('INSERT INTO rate_limits (key, bucket, count) VALUES (?, ?, 1) ON CONFLICT (key, bucket) DO UPDATE SET count = count + 1')
      .bind(key, bucket),
    db.prepare('SELECT bucket, count FROM rate_limits WHERE key = ? AND bucket IN (?, ?)').bind(key, bucket, bucket - 1),
  ]);
  let current = 0;
  let previous = 0;
  for (const row of read?.results ?? []) {
    if (row.bucket === bucket) current = row.count;
    else previous = row.count;
  }
  const estimate = current + previous * (1 - elapsed);
  return { allowed: estimate <= limit, estimate };
}

/**
 * The /64 network of an IPv6 address, like "2001:db8:1:2::/64", or null for IPv4 (and IPv4 written
 * as IPv6). A home or a phone gets a whole /64 and can rotate addresses inside it.
 */
export function ipv6Prefix64(ip: string): string | null {
  const a = ip.trim().toLowerCase();
  if (!a.includes(':') || a.includes('.')) return null;
  const [head = '', tail] = a.split('::', 2);
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return `${groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(':')}::/64`;
}

/** Drop buckets older than two windows (two hours for hourly keys). Run from the cron. */
export async function pruneRateLimits(db: D1Database, now = Date.now(), windowMs = RATE_WINDOW_MS): Promise<number> {
  const hourly = `${HOURLY_KEY_PREFIX}%`;
  const [perMinute, perHour] = await db.batch([
    db.prepare('DELETE FROM rate_limits WHERE bucket < ? AND key NOT LIKE ?').bind(Math.floor(now / windowMs) - 2, hourly),
    db.prepare('DELETE FROM rate_limits WHERE bucket < ? AND key LIKE ?').bind(Math.floor(now / HOUR_MS) - 2, hourly),
  ]);
  return (perMinute?.meta.changes ?? 0) + (perHour?.meta.changes ?? 0);
}
