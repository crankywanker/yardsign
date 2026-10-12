/**
 * Bill protection for paid identity providers. Three things live here:
 *
 *   1. The spend caps. Before every paid call, add up what the provider has billed this
 *      month and today. If the next call could push either over its cap, do not call.
 *      A failed sum also means do not call. Nothing here can spend; it can only say no.
 *   2. The engagement gate. Only ask about visitors who acted like a person: two or more
 *      page views in the session, or ten seconds on one page. A fresh single view is left
 *      alone for a while in case the second view or the unload beacon is still coming.
 *   3. The alerts. One email to the operator when month-to-date spend crosses 50% and 80%
 *      of the monthly cap, when the monthly cap stops a call, and when the daily cap stops
 *      one. Each is sent once (per month, or per day for the daily one); the spend_alerts
 *      table remembers which went out.
 *
 * Costs are counted at the first-band rate the provider reports (Delivr: 2.5 cents a row,
 * stored rounded up to 3). That overstates the real bill, which is the safe direction.
 */
import { claimSpendAlert, dayStartMs, monthStartMs, releaseSpendAlert, sessionEngagement, sumIdentityCostSince } from '@yardsign/db';
import type { Env } from './env';
import { getEmailSender, type EmailSender } from './email/sender';
import { capVar } from './env';
import { errorFields, type Logger } from './log';
import { APP_NAME } from './plans';

/** Defaults, also the fallback when the var is missing or not a whole number. "0" means no paid calls at all. */
export const DEFAULT_MONTHLY_CAP_CENTS = 125_000; // $1,250
export const DEFAULT_DAILY_CAP_CENTS = 1_000; // $10, about 400 full-profile rows
/** Human signals: this many page views in the session, or this long on one page. */
export const ENGAGEMENT_MIN_VIEWS = 2;
export const ENGAGEMENT_MIN_TIME_ON_PAGE_MS = 10_000;
/** How long a single quiet page view waits for a second view or the unload beacon before it is skipped. */
export const ENGAGEMENT_WAIT_MS = 30 * 60 * 1000;
/** Month-to-date percentages that get a heads-up email. 100% is the cap itself. */
export const ALERT_PERCENTS = [50, 80] as const;

export type SpendBlockReason = 'spend_cap' | 'daily_spend_cap' | 'spend_check_error';

export interface SpendCaps {
  monthlyCapCents: number;
  dailyCapCents: number;
}

export function spendCaps(env: Pick<Env, 'DELIVR_MONTHLY_CAP_CENTS' | 'DELIVR_DAILY_CAP_CENTS'>): SpendCaps {
  return {
    monthlyCapCents: capVar(env.DELIVR_MONTHLY_CAP_CENTS, DEFAULT_MONTHLY_CAP_CENTS),
    dailyCapCents: capVar(env.DELIVR_DAILY_CAP_CENTS, DEFAULT_DAILY_CAP_CENTS),
  };
}

export type SpendCheck =
  | { ok: true; monthCents: number; dayCents: number }
  | { ok: false; reason: SpendBlockReason; monthCents: number; dayCents: number };

/**
 * May the next call go out? `worstCaseCents` is the most that call can bill; calls still pending
 * (in flight, or cut off mid-call) count at that too. The month is checked first, then the day.
 * A query failure fails closed: the answer is no.
 */
export async function checkSpendCaps(db: D1Database, provider: string, worstCaseCents: number, caps: SpendCaps, now = Date.now()): Promise<SpendCheck> {
  let monthCents = 0;
  let dayCents = 0;
  const worst = Math.max(0, Math.ceil(worstCaseCents));
  try {
    monthCents = await sumIdentityCostSince(db, provider, monthStartMs(now), worst);
    dayCents = await sumIdentityCostSince(db, provider, dayStartMs(now), worst);
  } catch {
    return { ok: false, reason: 'spend_check_error', monthCents, dayCents };
  }
  if (monthCents + worst > caps.monthlyCapCents) return { ok: false, reason: 'spend_cap', monthCents, dayCents };
  if (dayCents + worst > caps.dailyCapCents) return { ok: false, reason: 'daily_spend_cap', monthCents, dayCents };
  return { ok: true, monthCents, dayCents };
}

export type EngagementVerdict = 'engaged' | 'wait' | 'skip';

/**
 * Did this session act like a person? 'wait' means the visit is still young enough that the
 * second page view or the time-on-page beacon may still arrive; try again next poll.
 */
export async function engagementVerdict(db: D1Database, visit: { site_id: string; session_id: string; created_at: number }, now = Date.now()): Promise<EngagementVerdict> {
  const e = await sessionEngagement(db, visit.site_id, visit.session_id);
  if (e.views >= ENGAGEMENT_MIN_VIEWS || e.maxTimeOnPageMs >= ENGAGEMENT_MIN_TIME_ON_PAGE_MS) return 'engaged';
  return now - visit.created_at < ENGAGEMENT_WAIT_MS ? 'wait' : 'skip';
}

// ---------- alerts ----------

export interface SpendAlertOptions {
  /** Null when no email can go out: the alert is then written to the log at error level, still once. */
  sender: EmailSender | null;
  from: string;
  to: string;
  /** Where the operator can see the numbers. Optional. */
  adminUrl?: string;
  provider?: string;
}

const usd = (cents: number): string => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const monthKey = (now: number): string => new Date(now).toISOString().slice(0, 7);
const dayKey = (now: number): string => new Date(now).toISOString().slice(0, 10);

function nextMonthLabel(now: number): string {
  const d = new Date(now);
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return next.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
}

export class SpendAlerter {
  private readonly provider: string;
  constructor(private readonly opts: SpendAlertOptions) {
    this.provider = opts.provider ?? 'delivr';
  }

  /** Month-to-date crossed 50% or 80% of the cap? Send what has not been sent yet this month. Returns the subjects sent. */
  async checkThresholds(db: D1Database, log: Logger, monthCents: number, caps: SpendCaps, now = Date.now()): Promise<string[]> {
    const sent: string[] = [];
    for (const pct of ALERT_PERCENTS) {
      if (monthCents * 100 < caps.monthlyCapCents * pct) continue;
      const key = `${this.provider}:month:${monthKey(now)}:${pct}`;
      const subject = `${APP_NAME}: Delivr spend at ${pct}% of ${usd(caps.monthlyCapCents)} cap`;
      const body = [
        `Delivr spend so far this month is about ${usd(monthCents)}. The monthly cap is ${usd(caps.monthlyCapCents)}.`,
        `At the cap, ${APP_NAME} stops asking Delivr about visitors until ${nextMonthLabel(now)}. No lead is lost on purpose; the visits are marked "spend cap".`,
        `The number is an estimate at the first-band rate, so it runs a little high. Delivr's own invoice is the truth.`,
      ];
      if (await this.sendOnce(db, log, key, subject, body, now)) sent.push(subject);
    }
    return sent;
  }

  /** The monthly cap stopped a call. Once per month. */
  async monthlyCapHit(db: D1Database, log: Logger, monthCents: number, caps: SpendCaps, now = Date.now()): Promise<boolean> {
    const key = `${this.provider}:month:${monthKey(now)}:100`;
    const subject = `${APP_NAME}: Delivr monthly cap hit (${usd(caps.monthlyCapCents)}). Calls paused until ${nextMonthLabel(now)}`;
    const body = [
      `Delivr spend this month reached the ${usd(caps.monthlyCapCents)} cap (about ${usd(monthCents)} counted).`,
      `${APP_NAME} has stopped asking Delivr about visitors. It starts again on ${nextMonthLabel(now)}, or sooner if you raise DELIVR_MONTHLY_CAP_CENTS and deploy.`,
      `Visits that arrive in the meantime are stored and marked "spend cap" on the admin page. They are not sent to Delivr later.`,
    ];
    return this.sendOnce(db, log, key, subject, body, now);
  }

  /** The daily cap stopped a call. Once per day. */
  async dailyCapHit(db: D1Database, log: Logger, dayCents: number, caps: SpendCaps, now = Date.now()): Promise<boolean> {
    const key = `${this.provider}:day:${dayKey(now)}:cap`;
    const subject = `${APP_NAME}: Delivr daily cap hit (${usd(caps.dailyCapCents)}). Calls paused until midnight UTC`;
    const body = [
      `Delivr spend today reached the ${usd(caps.dailyCapCents)} daily cap (about ${usd(dayCents)} counted).`,
      `This usually means a burst of traffic, maybe bots. ${APP_NAME} has stopped asking Delivr about visitors until midnight UTC, when the day resets.`,
      `Visits in the meantime are stored and marked "daily spend cap" on the admin page. Check the admin page for where the traffic came from.`,
    ];
    return this.sendOnce(db, log, key, subject, body, now);
  }

  private async sendOnce(db: D1Database, log: Logger, key: string, subject: string, paragraphs: string[], now: number): Promise<boolean> {
    if (!(await claimSpendAlert(db, key, now))) return false;
    const lines = [...paragraphs, this.opts.adminUrl ? `Admin page: ${this.opts.adminUrl}` : '', `Sent by ${APP_NAME}.`].filter(Boolean);
    const text = lines.join('\n\n');
    const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#16211b;padding:16px">${lines
      .map((l) => `<p>${escapeHtml(l)}</p>`)
      .join('')}</body></html>`;
    if (!this.opts.sender) {
      log.error(`spend alert (no email configured): ${subject}`, { key, text });
      return true;
    }
    try {
      await this.opts.sender.send({ to: this.opts.to, from: this.opts.from, subject, text, html });
      log.warn('spend alert sent', { key, to: this.opts.to, subject });
      return true;
    } catch (err) {
      log.error('spend alert: email failed; will retry on the next check', { key, subject, ...errorFields(err) });
      await releaseSpendAlert(db, key).catch(() => {});
      return false;
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

/**
 * The alerter from env. When SPEND_ALERT_EMAIL, EMAIL_PROVIDER or EMAIL_API_KEY is missing, the
 * alerter has no sender and writes each alert to the log at error level instead, still once each.
 */
export function getSpendAlerter(env: Env, log: Logger): SpendAlerter {
  const to = (env.SPEND_ALERT_EMAIL ?? '').trim();
  const base = (env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
  const adminUrl = base ? `${base}/admin` : undefined;
  if (!to) {
    log.error('spend alert: SPEND_ALERT_EMAIL is not set; alerts go to the log only');
    return new SpendAlerter({ sender: null, from: '', to: '', adminUrl });
  }
  let email: ReturnType<typeof getEmailSender> = null;
  try {
    email = getEmailSender(env);
  } catch (err) {
    log.error('spend alert: email sender is misconfigured; alerts go to the log only', errorFields(err));
  }
  if (!email) {
    log.error('spend alert: EMAIL_PROVIDER or EMAIL_API_KEY is not set; alerts go to the log only');
    return new SpendAlerter({ sender: null, from: '', to, adminUrl });
  }
  return new SpendAlerter({ sender: email.sender, from: email.from, to, adminUrl });
}
