/** sha256(salt | ip) as lowercase hex. The salt is per environment and must never change once live. */
export async function hashIp(ip: string, salt: string): Promise<string> {
  if (!salt) throw new Error('IP_SALT is not set');
  const data = new TextEncoder().encode(`${salt}|${ip.trim()}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string compare for tokens. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
