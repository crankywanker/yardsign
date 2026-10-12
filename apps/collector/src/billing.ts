/**
 * Stripe Checkout + webhook. Ported from the old app's billing.ts onto the new
 * accounts/sites tables. One subscription per site: it is stored on the site it paid
 * for, and cancelling it turns off that site only. The Checkout Session id is the
 * idempotency key, because the webhook and /welcome can both land first and Stripe
 * retries webhooks.
 *
 * The email typed at checkout is not verified, so a checkout never changes an existing
 * account. It adds a site to one only when Stripe's customer id matches the account's;
 * otherwise the site is created off and the operator is emailed to finish by hand.
 */
import Stripe from 'stripe';
import { ensureDelivrPixel } from './delivr-pixel';
import { getEmailSender, type EmailEnv } from './email/sender';
import { createLogger, errorFields, type Logger } from './log';
import {
  getAccountByEmail,
  getSiteByStripeSession,
  insertSite,
  newId,
  type Site,
} from '@yardsign/db';
import { APP_NAME, PLANS, type PlanId } from './plans';

export interface StripeEnv extends EmailEnv {
  DB: D1Database;
  DELIVR_API_KEY?: string;
  DELIVR_API_SECRET?: string;
  DELIVR_PROJECT_ID?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_STARTER?: string;
  STRIPE_PRICE_PRO?: string;
  /** The operator's address, shared with the spend alerts. A checkout that needs a person is emailed here. */
  SPEND_ALERT_EMAIL?: string;
}

/** All four secrets, the webhook's included: without it a paid checkout would never be provisioned. */
export function stripeConfigured(env: StripeEnv): boolean {
  return !!(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET && env.STRIPE_PRICE_STARTER && env.STRIPE_PRICE_PRO);
}

export function stripeClient(env: StripeEnv, fetchFn?: typeof fetch): Stripe {
  if (!env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not set');
  return new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient(fetchFn) });
}

/** "https://www.Example.com/path" -> "example.com" */
export function cleanDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^www\./, '')
    .split(/[/?#]/)[0]!
    .slice(0, 253);
}

export function isPlanId(v: unknown): v is PlanId {
  return v === 'starter' || v === 'pro';
}

/** Create a Checkout Session for a subscription. Returns the URL to send the buyer to. */
export async function createCheckout(env: StripeEnv, plan: PlanId, email: string, domain: string, baseUrl: string, fetchFn?: typeof fetch): Promise<string> {
  const price = plan === 'pro' ? env.STRIPE_PRICE_PRO : env.STRIPE_PRICE_STARTER;
  if (!price) throw new Error(`Stripe price id for ${plan} not set`);
  const session = await stripeClient(env, fetchFn).checkout.sessions.create({
    mode: 'subscription',
    customer_email: email,
    line_items: [{ price, quantity: 1 }],
    success_url: `${baseUrl}/welcome?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/#pricing`,
    metadata: { plan, domain },
    subscription_data: { metadata: { plan, domain } },
    allow_promotion_codes: true,
  });
  if (!session.url) throw new Error('Stripe returned no checkout URL');
  return session.url;
}

/** The parts of a Checkout Session provisioning needs. Narrow on purpose so tests can build one. */
export interface CheckoutLike {
  id: string;
  status: string | null;
  mode?: string | null;
  payment_status?: string | null;
  customer_email?: string | null;
  customer_details?: { email?: string | null } | null;
  customer?: string | { id: string } | null;
  subscription?: string | { id: string } | null;
  metadata?: Record<string, string> | null;
}

function randomSiteKey(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return [...crypto.getRandomValues(new Uint8Array(12))].map((b) => alphabet[b % alphabet.length]).join('');
}

/** Why a paid site waits for the operator: the checkout email has an account, but under another Stripe customer. */
export const REVIEW_OTHER_CUSTOMER = 'email_has_account_with_other_stripe_customer';

/**
 * A finished, paid subscription checkout for a plan we sell. "no_payment_required" is a
 * 100%-off promotion code. A delayed payment method finishes "unpaid" and is provisioned
 * on checkout.session.async_payment_succeeded instead.
 */
function paidSubscription(cs: CheckoutLike): boolean {
  return cs.status === 'complete' && cs.mode === 'subscription' && (cs.payment_status === 'paid' || cs.payment_status === 'no_payment_required') && isPlanId(cs.metadata?.plan);
}

/** The unique index on sites.stripe_session_id said no: the webhook and /welcome raced. */
function isSessionRace(err: unknown): boolean {
  return /UNIQUE constraint failed: sites\.stripe_session_id/.test(err instanceof Error ? err.message : String(err));
}

/**
 * Create the account (for a new email) and the site for a paid Checkout Session. Idempotent on
 * the session id. Never changes an existing account. Lead cards go to the buyer's email right away,
 * unless the site needs review: then it is created off and the operator gets an email.
 */
export async function provision(env: StripeEnv, cs: CheckoutLike, now = Date.now(), log: Logger = createLogger({ req_id: 'provision' }), fetchFn?: typeof fetch): Promise<Site | null> {
  if (!paidSubscription(cs)) return null;
  const existing = await getSiteByStripeSession(env.DB, cs.id);
  if (existing) return existing;

  const email = (cs.customer_details?.email ?? cs.customer_email ?? '').toLowerCase();
  if (!email) throw new Error(`Checkout session ${cs.id} has no email`);
  const plan = cs.metadata?.plan as PlanId; // checked by paidSubscription
  const domain = cleanDomain(cs.metadata?.domain ?? '');
  const customer = typeof cs.customer === 'string' ? cs.customer : (cs.customer?.id ?? null);
  const subscription = typeof cs.subscription === 'string' ? cs.subscription : (cs.subscription?.id ?? null);

  // A new email gets an account. An existing one is never touched: the checkout email is not verified.
  const created = await env.DB.prepare(
    "INSERT INTO accounts (id, name, email, plan, stripe_customer_id, stripe_subscription_id, monthly_quota, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?) ON CONFLICT(email) DO NOTHING",
  )
    .bind(`acct_${newId().replace(/-/g, '').slice(0, 12)}`, domain || email, email, plan, customer, subscription, PLANS[plan].quota, now)
    .run();
  const account = await getAccountByEmail(env.DB, email);
  if (!account) throw new Error('account upsert failed');
  // Ours to add to: we just made it, or Stripe says the same customer paid (a second site).
  const review = (created.meta.changes ?? 0) > 0 || (!!customer && account.stripe_customer_id === customer) ? null : REVIEW_OTHER_CUSTOMER;

  let site: Site;
  try {
    site = await insertSite(env.DB, {
      accountId: account.id,
      siteKey: randomSiteKey(),
      name: domain || email,
      allowedDomains: domain ? [domain] : [],
      leadEmail: email,
      stripeSessionId: cs.id,
      stripeSubscriptionId: subscription,
      active: !review,
      reviewReason: review,
    }, now);
  } catch (err) {
    // The webhook and /welcome raced; the unique index on stripe_session_id made one of them lose.
    if (!isSessionRace(err)) throw err;
    return getSiteByStripeSession(env.DB, cs.id);
  }
  if (review) {
    log.warn('billing: checkout needs review; site created off', { session_id: cs.id, site_id: site.id, account_id: account.id, reason: review });
    await alertOperator(env, log, `${APP_NAME}: a checkout needs your review (${domain || 'no domain'})`, [
      `Someone paid for ${PLANS[plan].name} at checkout with the email ${email}, for ${domain || 'no domain'}.`,
      `That email already has an account (${account.id}), but the payment came from a different Stripe customer (${customer ?? 'none'}). So the new site is on that account but turned off, and nothing about the account changed.`,
      `Site key: ${site.siteKey}. Stripe checkout session: ${cs.id}. Subscription: ${subscription ?? 'none'}.`,
      `To finish: check in Stripe that this buyer owns the account. If so, turn the site on (sites.active = 1, review_reason = NULL) and give it a Delivr pixel (PUT /api/admin/sites/${site.siteKey}/delivr). If not, refund the payment in Stripe.`,
      `The buyer's welcome page says we will finish setting up by email.`,
    ]);
    return site;
  }
  // A paying customer should resolve real people from day one: give the site its Delivr pixel now.
  const pixelId = await ensureDelivrPixel(env, site, log, fetchFn);
  return pixelId ? { ...site, delivrPixelId: pixelId } : site;
}

/** Email the operator at SPEND_ALERT_EMAIL, the spend alerts' address. Logged at error level when email is off. Never throws. */
async function alertOperator(env: StripeEnv, log: Logger, subject: string, paragraphs: string[]): Promise<void> {
  const to = (env.SPEND_ALERT_EMAIL ?? '').trim();
  let email: ReturnType<typeof getEmailSender> = null;
  try {
    email = to ? getEmailSender(env) : null;
  } catch (err) {
    log.error('billing alert: email sender is misconfigured', errorFields(err));
  }
  if (!email) {
    log.error(`billing alert (no email configured): ${subject}`);
    return;
  }
  const lines = [...paragraphs, `Sent by ${APP_NAME}.`];
  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#16211b;padding:16px">${lines
    .map((l) => `<p>${escapeHtml(l)}</p>`)
    .join('')}</body></html>`;
  try {
    await email.sender.send({ to, from: email.from, subject, text: lines.join('\n\n'), html });
    log.warn('billing alert sent', { subject });
  } catch (err) {
    log.error('billing alert: email failed', { subject, ...errorFields(err) });
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

/** What /welcome shows for a Checkout Session: its site, "still processing", or "this checkout expired". */
export type WelcomeState = { kind: 'site'; site: Site } | { kind: 'pending' } | { kind: 'expired' };

/** Look up a Checkout Session (for /welcome) and make sure it is provisioned. Asks Stripe only until the site exists. */
export async function siteForSession(env: StripeEnv, sessionId: string, fetchFn?: typeof fetch): Promise<WelcomeState> {
  const known = await getSiteByStripeSession(env.DB, sessionId);
  if (known) return { kind: 'site', site: known };
  const cs = await stripeClient(env, fetchFn).checkout.sessions.retrieve(sessionId);
  if (cs.status === 'expired') return { kind: 'expired' };
  const site = await provision(env, cs);
  return site ? { kind: 'site', site } : { kind: 'pending' };
}

export type WebhookOutcome = { ok: true; handled: string } | { ok: false; status: number; error: string };

/** Verify the signature and handle the events we care about. */
export async function handleStripeWebhook(env: StripeEnv, rawBody: string, signature: string): Promise<WebhookOutcome> {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) return { ok: false, status: 503, error: 'Stripe not configured' };
  let event: Stripe.Event;
  try {
    event = await stripeClient(env).webhooks.constructEventAsync(rawBody, signature, env.STRIPE_WEBHOOK_SECRET, undefined, Stripe.createSubtleCryptoProvider());
  } catch (err) {
    return { ok: false, status: 400, error: `signature failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    await provision(env, event.data.object as unknown as CheckoutLike);
    return { ok: true, handled: event.type };
  }
  if (event.type === 'customer.subscription.deleted') {
    // Turn off the site(s) this subscription paid for. Never the account: it may have other paid sites.
    const sub = event.data.object as { id: string };
    await env.DB.prepare('UPDATE sites SET active = 0 WHERE stripe_subscription_id = ?').bind(sub.id).run();
    return { ok: true, handled: event.type };
  }
  return { ok: true, handled: 'ignored' };
}
