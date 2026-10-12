/** Obvious bots by user agent. Cheap and good enough until Bot Management data is on the plan. */
const BOT_UA =
  /bot|crawl|spider|slurp|headless|phantom|lighthouse|pagespeed|gtmetrix|pingdom|preview|facebookexternalhit|curl\/|wget\/|python-requests|python-urllib|go-http-client|java\/|okhttp|httpclient|scrapy|axios\/|node-fetch|libwww|monitor/i;

/** Cloudflare bot scores run 1 (bot) to 99 (human). Below this we drop the visit. */
export const BOT_SCORE_DROP_BELOW = 30;

export function isBotUserAgent(ua: string | null | undefined): boolean {
  if (!ua || ua.trim().length < 10) return true;
  return BOT_UA.test(ua);
}

export interface BotSignals {
  userAgent: string | null;
  /** request.cf.botManagement.score when present. */
  botScore: number | null;
  verifiedBot: boolean;
}

export function isBot(s: BotSignals): boolean {
  if (s.verifiedBot) return true;
  if (isBotUserAgent(s.userAgent)) return true;
  if (s.botScore !== null && s.botScore < BOT_SCORE_DROP_BELOW) return true;
  return false;
}
