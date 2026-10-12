/**
 * The opt-out promise on /privacy: "Opting out deletes every lead about you that we hold and tells
 * each roofer who received one to delete it within 10 business days." This file is the second half.
 * One email per business, listing only what it needs to find the person in its own records.
 */
import { deleteRecalls, pendingRecalls, recallFailed, type OptOutRecall } from '@yardsign/db';
import { getEmailSender, type EmailEnv } from './email/sender';
import { errorFields, type Logger } from './log';

export const DELETE_WITHIN_BUSINESS_DAYS = 10;

/** The date `n` business days (Mon to Fri) after `from`, as YYYY-MM-DD in UTC. */
export function addBusinessDays(from: number, n: number): string {
  const d = new Date(from);
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) left--;
  }
  return d.toISOString().slice(0, 10);
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function recallMessage(app: string, rows: OptOutRecall[], now: number): { subject: string; text: string; html: string } {
  const by = addBusinessDays(now, DELETE_WITHIN_BUSINESS_DAYS);
  const lines = rows.map((r) => {
    const name = [r.first_name, r.last_name].filter(Boolean).join(' ') || 'Name not available';
    const where = [r.city, r.state].filter(Boolean).join(', ');
    return `${name}${r.email ? `, ${r.email}` : ''}${where ? `, ${where}` : ''} (lead sent ${new Date(r.created_at).toISOString().slice(0, 10)} from ${r.site_name})`;
  });
  const intro = `A person you received a lead about has opted out of ${app}. Under our terms, please delete their information from your CRM, inbox and any lists by ${by} (${DELETE_WITHIN_BUSINESS_DAYS} business days). Do not contact them about this lead.`;
  const text = `${intro}\n\n${lines.map((l) => `- ${l}`).join('\n')}\n\nWe have already deleted our copy. Questions: reply to this email.`;
  const html = `<p>${esc(intro)}</p><ul>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul><p>We have already deleted our copy. Questions: reply to this email.</p>`;
  return { subject: `Please delete a lead by ${by}: the person opted out`, text, html };
}

/** How long a fresh opt-out's own send has before the cron counts its recalls as due. */
export const RECALL_RETRY_AFTER_MS = 10 * 60 * 1000;

/**
 * Email each business its recall notices: the ones named (right after an opt-out), or every
 * one that is due (the cron). A sent notice is deleted, so nothing about the person is kept; a
 * failed one stays and is tried again later. Never throws; logs counts only, never the person.
 * Returns emails sent.
 */
export async function sendOptOutRecalls(
  env: EmailEnv & { DB: D1Database },
  app: string,
  log: Logger,
  opts: { ids?: string[]; now?: number } = {},
): Promise<number> {
  const now = opts.now ?? Date.now();
  let rows: OptOutRecall[];
  try {
    rows = await pendingRecalls(env.DB, opts.ids ? { ids: opts.ids } : { dueBefore: now - RECALL_RETRY_AFTER_MS, now });
  } catch (err) {
    log.error('optout: could not read recalls', errorFields(err));
    return 0;
  }
  if (rows.length === 0) return 0;
  let email: ReturnType<typeof getEmailSender> = null;
  try {
    email = getEmailSender(env);
  } catch (err) {
    log.error('optout: email misconfigured, recall not sent', errorFields(err));
  }
  if (!email) {
    await recallFailed(env.DB, rows.map((r) => r.id), 'email not configured', now).catch(() => undefined);
    log.error('optout: email not set up, recall not sent; the cron will try again', { businesses: new Set(rows.map((r) => r.notify_email)).size });
    return 0;
  }
  const byTo = new Map<string, OptOutRecall[]>();
  for (const r of rows) byTo.set(r.notify_email, [...(byTo.get(r.notify_email) ?? []), r]);
  let sent = 0;
  for (const [to, list] of byTo) {
    const ids = list.map((r) => r.id);
    try {
      await email.sender.send({ to, from: email.from, ...recallMessage(app, list, now) });
    } catch (err) {
      log.error('optout: recall email failed', { leads: list.length, attempts: Math.max(...list.map((r) => r.attempts)) + 1, ...errorFields(err) });
      await recallFailed(env.DB, ids, err instanceof Error ? err.message : String(err), now).catch(() => undefined);
      continue;
    }
    sent++;
    try {
      await deleteRecalls(env.DB, ids);
    } catch (err) {
      log.error('optout: recall sent but not cleared; it may go out twice', errorFields(err));
    }
  }
  log.info('optout: recall sent', { businesses: byTo.size, emails_sent: sent, leads: rows.length });
  return sent;
}
