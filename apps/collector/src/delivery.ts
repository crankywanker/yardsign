/**
 * Delivery stub. One channel, "log": print the lead and mark it delivered.
 * Real channels (email, webhook, JobNimbus) replace this with the same shape.
 */
import {
  DAY_MS,
  claimDeliveryRetry,
  finishDeliveryRetry,
  getLead,
  getSiteById,
  insertDelivery,
  latestScoresForLeads,
  listRecentPathsForVisitor,
  listRetryableDeliveries,
  updateDelivery,
  type LeadRow,
  type RetryableDelivery,
  type Site,
  type VisitRow,
} from '@yardsign/db';
import { hailFactsFromScore, type HailFacts } from './email/hail';
import { leadHtml, leadSubject, leadText, returnHtml, returnSubject, returnText, type LeadCardInput } from './email/lead-card';
import { getEmailSender, type EmailEnv, type EmailSender } from './email/sender';
import { intVar } from './env';
import { visitorIntent } from './intent';
import { errorFields, type Logger } from './log';
import { WebhookChannel } from './webhook';

export interface DeliveryChannel {
  readonly name: string;
  send(lead: LeadRow, payload: LeadPayload, log: Logger): Promise<void>;
}

/** What a customer's CRM will receive. Keep it flat and boring. */
export interface LeadPayload {
  lead_id: string;
  site_id: string;
  first_name: string | null;
  last_name: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone: string | null;
  email: string | null;
  confidence: number | null;
  /** True when we have no name or no street address yet (often an email only). */
  partial: boolean;
  extra: unknown;
  created_at: string;
  source: 'Yardsign';
}

/** A full lead has a name and a street address. Anything less is a partial lead. */
export function isPartialLead(lead: Pick<LeadRow, 'first_name' | 'last_name' | 'address_line1'>): boolean {
  return !((lead.first_name || lead.last_name) && lead.address_line1);
}

/** The only keys of `leads.extra` a customer gets. Provider ids and anything else stay with us. */
const CUSTOMER_EXTRA_KEYS = ['provider', 'mock', 'is_homeowner'] as const;

export function toLeadPayload(lead: LeadRow): LeadPayload {
  let stored: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(lead.extra);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed as Record<string, unknown>;
  } catch {
    stored = {};
  }
  const extra: Record<string, unknown> = {};
  for (const k of CUSTOMER_EXTRA_KEYS) if (k in stored) extra[k] = stored[k];
  return {
    lead_id: lead.id,
    site_id: lead.site_id,
    first_name: lead.first_name,
    last_name: lead.last_name,
    address_line1: lead.address_line1,
    address_line2: lead.address_line2,
    city: lead.city,
    state: lead.state,
    zip: lead.zip,
    phone: lead.phone,
    email: lead.email,
    confidence: lead.confidence,
    partial: isPartialLead(lead),
    extra,
    created_at: new Date(lead.created_at).toISOString(),
    source: 'Yardsign',
  };
}

/** Ids only: the person's name, address, phone and email never go to the logs. */
export class LogChannel implements DeliveryChannel {
  readonly name = 'log';
  async send(_lead: LeadRow, payload: LeadPayload, log: Logger): Promise<void> {
    log.info('lead delivered (log channel)', { lead_id: payload.lead_id, site_id: payload.site_id });
  }
}

/** last_error on an email delivery when the site has a lead email but email is not set up. A retry cannot fix it. */
export const EMAIL_NOT_CONFIGURED = 'email_not_configured';

/**
 * Stands in for the email channel when the site has a lead email but email is not set up
 * (EMAIL_PROVIDER, EMAIL_API_KEY or EMAIL_FROM missing). Every send fails, so the delivery is
 * recorded as failed and shows on the dashboard and /admin instead of being marked delivered.
 */
class UnconfiguredEmailChannel implements DeliveryChannel {
  readonly name = 'email';
  async send(): Promise<void> {
    throw new Error(EMAIL_NOT_CONFIGURED);
  }
}

export interface EmailChannelOptions {
  sender: EmailSender;
  from: string;
  to: string;
  siteName: string;
  /** Lookups the card needs. Kept as a function so tests can stub it. */
  context: (lead: LeadRow) => Promise<Pick<LeadCardInput, 'pages' | 'connection' | 'mock' | 'recheckDays' | 'intent' | 'hail'>>;
  dashboardUrl?: string;
}

/** Emails the lead card to the site's lead_email address. */
export class EmailChannel implements DeliveryChannel {
  readonly name = 'email';
  constructor(private readonly opts: EmailChannelOptions) {}
  async send(lead: LeadRow, payload: LeadPayload, log: Logger): Promise<void> {
    const ctx = await this.opts.context(lead);
    const input: LeadCardInput = { payload, siteName: this.opts.siteName, dashboardUrl: this.opts.dashboardUrl, ...ctx };
    const res = await this.opts.sender.send({
      to: this.opts.to,
      from: this.opts.from,
      subject: leadSubject(input),
      html: leadHtml(input),
      text: leadText(input),
    });
    log.info('lead delivered (email channel)', { to: this.opts.to, provider: this.opts.sender.name, message_id: res.id, mock: ctx.mock });
  }
}

/**
 * Which channels a lead on this site goes to. Email when the site has a lead_email (recorded
 * as failed with `email_not_configured` when email is not set up); a webhook when the site has
 * one; the log channel when the site has neither.
 */
export function getDeliveryChannels(
  env: EmailEnv & { PUBLIC_BASE_URL?: string; RECHECK_DAYS?: string },
  db: D1Database,
  site: Site,
  visit: Pick<VisitRow, 'city' | 'region'>,
  providerName: string,
  log: Logger,
  /** Hail near the home, for the email card. Undefined leaves the hail box off. */
  hail?: HailFacts,
): DeliveryChannel[] {
  const channels: DeliveryChannel[] = [];
  const mock = providerName === 'mock';
  const pagesFor = (lead: LeadRow) => listRecentPathsForVisitor(db, site.id, lead.visitor_id);

  if (site.leadEmail) {
    let email: ReturnType<typeof getEmailSender> = null;
    try {
      email = getEmailSender(env);
    } catch (err) {
      log.error('email: misconfigured', { error: err instanceof Error ? err.message : String(err) });
    }
    if (email) {
      channels.push(
        new EmailChannel({
          sender: email.sender,
          from: email.from,
          to: site.leadEmail,
          siteName: site.name,
          context: async (lead) => ({
            pages: await pagesFor(lead),
            connection: { city: visit.city, region: visit.region },
            mock,
            recheckDays: intVar(env.RECHECK_DAYS, 7),
            intent: await visitorIntent(db, site.id, lead.visitor_id),
            hail,
          }),
        }),
      );
    } else {
      log.error('email: site has lead_email but email is not set up; the email delivery will be recorded as failed', { site_id: site.id });
      channels.push(new UnconfiguredEmailChannel());
    }
  }

  if (site.webhookUrl) {
    channels.push(new WebhookChannel(site.webhookUrl, site.webhookKind ?? 'json', async (lead) => ({ siteName: site.name, pages: await pagesFor(lead), mock, hail })));
  }

  if (channels.length === 0) channels.push(new LogChannel());
  return channels;
}

export const RETURN_ALERT_CHANNEL = 'email:return';

/** The "they're back" email for a lead who returned to the site. Email only for now. */
class ReturnAlertChannel implements DeliveryChannel {
  readonly name = RETURN_ALERT_CHANNEL;
  constructor(
    private readonly opts: { sender: EmailSender; from: string; to: string; siteName: string; db: D1Database; siteId: string; pages: string[]; mock: boolean },
  ) {}
  async send(lead: LeadRow, payload: LeadPayload, log: Logger): Promise<void> {
    const input = { payload, siteName: this.opts.siteName, intent: await visitorIntent(this.opts.db, this.opts.siteId, lead.visitor_id), pages: this.opts.pages, mock: this.opts.mock };
    const res = await this.opts.sender.send({ to: this.opts.to, from: this.opts.from, subject: returnSubject(input), html: returnHtml(input), text: returnText(input) });
    log.info('return alert sent', { to: this.opts.to, provider: this.opts.sender.name, message_id: res.id, intent: input.intent.level });
  }
}

/** The return-alert channel for a site, or null when the site has no lead email or email is off. */
export function getReturnAlertChannel(env: EmailEnv, db: D1Database, site: Site, pages: string[], providerName: string, log: Logger): DeliveryChannel | null {
  if (!site.leadEmail) return null;
  let email: ReturnType<typeof getEmailSender> = null;
  try {
    email = getEmailSender(env);
  } catch (err) {
    log.error('email: misconfigured, skipping return alert', { error: err instanceof Error ? err.message : String(err) });
  }
  if (!email) return null;
  return new ReturnAlertChannel({ sender: email.sender, from: email.from, to: site.leadEmail, siteName: site.name, db, siteId: site.id, pages, mock: providerName === 'mock' });
}

/** Write the deliveries row, run the channel, record the outcome. Never throws. `skip` records the row as skipped instead of sending. */
export async function deliverLead(db: D1Database, lead: LeadRow, channel: DeliveryChannel, log: Logger, now = Date.now(), skip: string | null = null): Promise<string> {
  const payload = toLeadPayload(lead);
  const deliveryId = await insertDelivery(db, { leadId: lead.id, channel: channel.name, payload }, now);
  if (skip) {
    await updateDelivery(db, deliveryId, { status: 'skipped', lastError: skip, deliveredAt: null });
    return deliveryId;
  }
  try {
    await channel.send(lead, payload, log.child({ delivery_id: deliveryId }));
    await updateDelivery(db, deliveryId, { status: 'delivered', lastError: null, deliveredAt: Date.now() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('delivery failed', { delivery_id: deliveryId, channel: channel.name, error: message });
    await updateDelivery(db, deliveryId, { status: 'failed', lastError: message.slice(0, 1000), deliveredAt: null });
  }
  return deliveryId;
}

// ---------- retries ----------

/** A failed delivery gets at most this many tries in all, and only while it is under a day old. */
export const MAX_DELIVERY_ATTEMPTS = 5;
/** The wait after the first failed try. Each wait after that is three times longer: 5, 15, 45, 135 minutes. */
export const RETRY_FIRST_WAIT_MS = 5 * 60 * 1000;
/** Rows per cron run. Each send has a 10-second timeout, so a full batch stays well inside a run. */
const RETRY_BATCH = 20;

/**
 * The newest created_at a delivery with `attempts` tries may have to be due again. The waits add up
 * from the first try (5 + 15 + 45 ... minutes), so no extra column is needed.
 */
export function retryDueBefore(now: number, attempts: number): number {
  return now - (RETRY_FIRST_WAIT_MS * (3 ** attempts - 1)) / 2;
}

type RetryEnv = Parameters<typeof getDeliveryChannels>[0] & { DB: D1Database };

/** The channel a failed delivery went to, built the same way as the first time. Null when the site no longer has it. */
async function channelForRetry(env: RetryEnv, site: Site, lead: LeadRow, d: RetryableDelivery, log: Logger, now: number): Promise<DeliveryChannel | null> {
  if (d.channel === RETURN_ALERT_CHANNEL) {
    const pages = await listRecentPathsForVisitor(env.DB, site.id, lead.visitor_id, DAY_MS, now);
    return getReturnAlertChannel(env, env.DB, site, pages, d.provider, log);
  }
  const score = (await latestScoresForLeads(env.DB, [lead.id])).get(lead.id);
  const hail = score ? hailFactsFromScore(score) : undefined;
  const channels = getDeliveryChannels(env, env.DB, site, { city: d.visit_city, region: d.visit_region }, d.provider, log, hail);
  return channels.find((ch) => ch.name === d.channel) ?? null;
}

/**
 * The 5-minute cron's retry step: send failed deliveries again, waiting 5, 15, 45, then 135 minutes
 * between tries, for up to a day. Leaves alone a missing email setup (a retry cannot fix it), leads
 * that are gone (opted out), and channels the site no longer has. Never throws.
 */
export async function retryFailedDeliveries(env: RetryEnv, log: Logger, now = Date.now()): Promise<{ retried: number; delivered: number }> {
  let retried = 0;
  let delivered = 0;
  try {
    const dueBefore = Array.from({ length: MAX_DELIVERY_ATTEMPTS - 1 }, (_, i) => retryDueBefore(now, i + 1));
    const rows = await listRetryableDeliveries(env.DB, { since: now - DAY_MS, dueBefore, skipError: EMAIL_NOT_CONFIGURED, limit: RETRY_BATCH });
    for (const d of rows) {
      const dlog = log.child({ delivery_id: d.id, lead_id: d.lead_id, channel: d.channel });
      try {
        const [lead, site] = await Promise.all([getLead(env.DB, d.lead_id), getSiteById(env.DB, d.site_id)]);
        const channel = lead && site ? await channelForRetry(env, site, lead, d, dlog, now) : null;
        if (!lead || !channel) {
          // Nowhere to send it any more: stop retrying, keep the row as failed.
          await claimDeliveryRetry(env.DB, d.id, d.attempts, MAX_DELIVERY_ATTEMPTS);
          dlog.info('delivery retry: the lead is gone or the site no longer has this channel; giving up');
          continue;
        }
        if (!(await claimDeliveryRetry(env.DB, d.id, d.attempts))) continue; // another run took it
        retried++;
        try {
          await channel.send(lead, toLeadPayload(lead), dlog);
          await finishDeliveryRetry(env.DB, d.id, { status: 'delivered', lastError: null, deliveredAt: Date.now() });
          delivered++;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          dlog.warn('delivery retry failed', { attempt: d.attempts + 1, error: message });
          await finishDeliveryRetry(env.DB, d.id, { status: 'failed', lastError: message.slice(0, 1000), deliveredAt: null });
        }
      } catch (err) {
        dlog.error('delivery retry: unhandled failure', errorFields(err));
      }
    }
  } catch (err) {
    log.error('delivery retry: step failed', errorFields(err));
  }
  if (retried) log.info('delivery retry: done', { retried, delivered });
  return { retried, delivered };
}
