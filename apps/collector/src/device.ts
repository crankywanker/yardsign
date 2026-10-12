import type { DeviceInfo } from '@yardsign/db';

/** Coarse device info from the user agent. Enough for a dashboard column, not for fingerprinting. */
export function parseDevice(ua: string | null): DeviceInfo {
  const s = ua ?? '';
  let type: DeviceInfo['type'] = 'desktop';
  if (/ipad|tablet|silk/i.test(s) || (/android/i.test(s) && !/mobile/i.test(s))) type = 'tablet';
  else if (/mobile|iphone|ipod|android/i.test(s)) type = 'phone';
  else if (!s) type = 'other';

  let browser = 'Other';
  if (/edg(a|ios)?\//i.test(s)) browser = 'Edge';
  else if (/samsungbrowser\//i.test(s)) browser = 'Samsung Internet';
  else if (/opr\/|opera/i.test(s)) browser = 'Opera';
  else if (/firefox\/|fxios\//i.test(s)) browser = 'Firefox';
  else if (/chrome\/|crios\//i.test(s)) browser = 'Chrome';
  else if (/safari\//i.test(s)) browser = 'Safari';

  let os = 'Other';
  if (/windows/i.test(s)) os = 'Windows';
  else if (/iphone|ipad|ipod/i.test(s)) os = 'iOS';
  else if (/mac os x|macintosh/i.test(s)) os = 'macOS';
  else if (/android/i.test(s)) os = 'Android';
  else if (/cros/i.test(s)) os = 'ChromeOS';
  else if (/linux/i.test(s)) os = 'Linux';

  return { type, browser, os };
}
