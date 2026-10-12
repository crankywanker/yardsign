/**
 * The resolution step: one visit in, at most one provider call out, then
 * identity_requests, leads, deliveries and an address-level lead_scores row.
 * Safe to run twice on the same visit, even at the same time: before the call the step claims the
 * lookup (one pending identity_requests row per visitor, claimIdentityRequest), and a run that
 * loses the claim leaves the visit for later. The answer, the lead and the visit mark are written
 * in one batch, so a run that stops halfway leaves all of them or none.
 *
 * Order of the gates, cheapest and most certain first:
 *   site off, account suspended, gate 1 (src/policy.ts), the 30-day rule,
 *   then for paid providers only: the 24-hour rule, the monthly quota, the engagement gate,
 *   the provider's minimum visit age, and the spend caps (src/spend.ts).
 * An opted-out browser is skipped right after gate 1, before any lookup.
 * After a match: gate 3 (opt-out by any email, phone or home address; GPC) and gate 2 (ALLOWED_STATES).
 * A match that fails either never becomes a lead, so it is never delivered or shown to the roofer.
 */
import {
  DAY_MS,
  claimIdentityRequest,
  completeIdentityRequest,
  completeIdentityRequestStmt,
  countAccountLeadsSince,
  getAccount,
  getSiteById,
  getVisit,
  hadIdentityRequestRecently,
  hasUnfinishedMatch,
  type Site,
  insertLeadStmt,
  isPersonOptedOut,
  isVisitorOptedOut,
  listSitesWithUnresolvedVisits,
  listUnresolvedVisits,
  markResolveAttempted,
  markResolveAttemptedStmt,
  monthStartMs,
  personKeys,
  rememberOptedOutVisitor,
  hadDeliverySince,
  isFirstViewOfSession,
  latestLeadForVisitor,
  listRecentPathsForVisitor,
  lookupHistory,
  updateLeadLocation,
  type LeadRow,
  type VisitRow,
} from '@yardsign/db';
import { getProvider, type IdentityProvider, type ResolveInput, type ResolveResult } from '@yardsign/identity';
import { getGeocoder, scoreAndStore } from '@yardsign/scoring';
import { RETURN_ALERT_CHANNEL, deliverLead, getDeliveryChannels, getReturnAlertChannel, isPartialLead, type DeliveryChannel } from './delivery';
import { locationAdjusted, minConfidence } from './confidence';
import { hailFacts, type HailFacts } from './email/hail';
import { hailSourceName } from './hail-sync';
import { intVar, type Env } from './env';
import { errorFields, type Logger } from './log';
import { allowedStates, identityGate, leadGate } from './policy';
import { ENGAGEMENT_WAIT_MS, checkSpendCaps, engagementVerdict, getSpendAlerter, spendCaps, type SpendCheck } from './spend';

/** 'deferred': too early to ask; try again later. 'busy': another run holds this visitor's lookup; the visit is left for a later run. */
export type ProcessOutcome = 'missing' | 'already_attempted' | 'site_inactive' | 'skipped' | 'deduped' | 'deferred' | 'busy' | 'resolved' | 'no_match' | 'opted_out' | 'withheld' | 'low_confidence' | 'error';

export interface ProcessResult {
  outcome: ProcessOutcome;
  leadId?: string;
  identityRequestId?: string;
  /** Why the step did not call a provider, when outcome is 'skipped'. Matches visits.skip_reason. */
  skipReason?: string;
  /** When outcome is 'deferred': how long until the visit can be decided. The queue consumer waits this long. */
  retryAfterMs?: number;
}

export function toResolveInput(visit: VisitRow, site?: Pick<Site, 'delivrPixelId'> | null): ResolveInput {
  return {
    visitor_id: visit.visitor_id,
    visit_id: visit.id,
    site_id: visit.site_id,
    ip: visit.ip_raw,
    ip_hash: visit.ip_hash,
    user_agent: visit.user_agent,
    geo: {
      country: visit.country,
      region: visit.region,
      city: visit.city,
      postal: visit.postal,
      lat: visit.lat,
      lng: visit.lng,
      asn: visit.asn,
    },
    occurred_at: visit.occurred_at,
    created_at: visit.created_at,
    provider_site_id: site?.delivrPixelId ?? null,
  };
}

/** The provider payload we keep. The raw IP is left out on purpose; it has its own 72-hour column. */
function requestPayloadForStorage(input: ResolveInput): Omit<ResolveInput, 'ip'> & { ip_present: boolean } {
  const { ip, ...rest } = input;
  return { ...rest, ip_present: ip !== null };
}

export async function processVisit(
  env: Env,
  visitId: string,
  log: Logger,
  providerOverride?: IdentityProvider,
  channelOverride?: DeliveryChannel,
  now: () => number = () => Date.now(),
): Promise<ProcessResult> {
  const db = env.DB;
  const visit = await getVisit(db, visitId);
  if (!visit) {
    log.warn('resolution: visit not found', { visit_id: visitId });
    return { outcome: 'missing' };
  }
  if (visit.resolve_attempted_at !== null) return { outcome: 'already_attempted' };

  const site = await getSiteById(db, visit.site_id);
  if (!site || !site.active) {
    await markResolveAttempted(db, visit.id, Date.now(), 'site_inactive');
    return { outcome: 'site_inactive' };
  }
  // Delivr works per site pixel; a site without one stays on the mock provider.
  const provider = providerOverride ?? getProvider(env, site);
  const account = await getAccount(db, site.accountId);
  if (!account || account.status !== 'active') {
    await markResolveAttempted(db, visit.id, Date.now(), 'account_suspended');
    log.info('resolution: skipped, account suspended', { visit_id: visit.id, site_id: site.id });
    return { outcome: 'skipped', skipReason: 'account_suspended' };
  }

  // Gate 1, the same rule the pixel route used: no GPC, US, a known state in ALLOWED_STATES, not a data center.
  const allowed = allowedStates(env);
  const gate = identityGate({ gpc: visit.gpc === 1, country: visit.country, region: visit.region, asnClass: visit.asn_class ?? 'unknown' }, allowed);
  if (!gate.ok) {
    await markResolveAttempted(db, visit.id, Date.now(), gate.reason);
    log.info('resolution: skipped by gate', { visit_id: visit.id, site_id: visit.site_id, reason: gate.reason });
    return { outcome: 'skipped', skipReason: gate.reason };
  }

  // Gate 3 before any lookup: this browser opted out on this site. Never look them up (or pay) again.
  if (await isVisitorOptedOut(db, visit.site_id, visit.visitor_id)) {
    await markResolveAttempted(db, visit.id, Date.now(), 'opted_out');
    log.info('resolution: skipped, visitor opted out', { visit_id: visit.id, site_id: visit.site_id });
    return { outcome: 'skipped', skipReason: 'opted_out' };
  }

  // Per provider: the mock's fake answers never block or stand in for a real lookup.
  // A full lead (name and street address) closes the visitor for 30 days. An email-only match or
  // a miss stays open for the re-check window (RECHECK_DAYS, default 7) from the first time we
  // asked, so a return visit can fill it in; after that the buyer has likely hired someone.
  const history = await lookupHistory(db, visit.site_id, visit.visitor_id, now() - 30 * DAY_MS, provider.name);
  const recheckMs = intVar(env.RECHECK_DAYS, 7) * DAY_MS;
  // A visitor we already have a lead for came back: tell the contractor, once a day at most.
  // Called on every final exit below that does not create a new lead.
  const back = async (): Promise<void> => {
    if (history.hasLead) await alertIfReturning(env, site, visit, provider.name, log, now());
  };
  if (history.fullLead || (history.firstAskedAt !== null && now() - history.firstAskedAt > recheckMs)) {
    await markResolveAttempted(db, visit.id, Date.now(), 'deduped_30d');
    await back();
    log.info('resolution: skipped, visitor resolved in the last 30 days', { visit_id: visit.id, visitor_id: visit.visitor_id, site_id: visit.site_id });
    return { outcome: 'deduped' };
  }

  // Bill protection, paid providers only. The mock is free and skips all of this.
  const worstCaseCents = provider.maxCostCentsPerCall ?? 0;
  const billable = worstCaseCents > 0;
  if (billable) {
    // A paid match an earlier run stored but never turned into a lead (it stopped in between, before
    // the answer and the lead were written together). Do not pay for it again, and do not hide it.
    if (await hasUnfinishedMatch(db, visit.id, provider.name)) {
      await markResolveAttempted(db, visit.id, Date.now(), 'unfinished_match');
      log.error('resolution: this visit has a stored match but no lead; an earlier run stopped halfway', { visit_id: visit.id, visitor_id: visit.visitor_id, site_id: visit.site_id });
      return { outcome: 'skipped', skipReason: 'unfinished_match' };
    }
    // One billed call or match per visitor per day. A free miss does not count, so a return visit is asked again.
    if (await hadIdentityRequestRecently(db, visit.site_id, visit.visitor_id, DAY_MS, now(), provider.name)) {
      await markResolveAttempted(db, visit.id, Date.now(), 'deduped_24h');
      await back();
      log.info('resolution: skipped, visitor already asked about in the last 24 hours', { visit_id: visit.id, visitor_id: visit.visitor_id, site_id: visit.site_id });
      return { outcome: 'skipped', skipReason: 'deduped_24h' };
    }
    // Over the plan's monthly household limit: a new lead could not be sent, so do not pay for it.
    // Same line as the delivery check below: the next lead would make used + 1 > quota.
    if (account.monthly_quota > 0 && (await countAccountLeadsSince(db, account.id, monthStartMs(now()))) >= account.monthly_quota) {
      await markResolveAttempted(db, visit.id, Date.now(), 'over_quota');
      await back();
      log.info('resolution: skipped, account over its monthly quota', { visit_id: visit.id, site_id: visit.site_id, account_id: account.id, quota: account.monthly_quota });
      return { outcome: 'skipped', skipReason: 'over_quota' };
    }
    // Only people: a second page view or ten seconds on one page. A lone fresh view waits a while.
    // Off unless DELIVR_ENGAGEMENT_GATE = "on": a no-match is free and the caps still apply.
    const engagement = env.DELIVR_ENGAGEMENT_GATE === 'on' ? await engagementVerdict(db, visit, now()) : 'engaged';
    if (engagement === 'wait') return { outcome: 'deferred', retryAfterMs: ENGAGEMENT_WAIT_MS - (now() - visit.created_at) };
    if (engagement === 'skip') {
      await markResolveAttempted(db, visit.id, Date.now(), 'no_engagement');
      await back();
      log.info('resolution: skipped, no human signal in the session', { visit_id: visit.id, session_id: visit.session_id, site_id: visit.site_id });
      return { outcome: 'skipped', skipReason: 'no_engagement' };
    }
  }

  // Some providers need a few minutes after the page view before they can answer. Leave the
  // visit untouched (resolve_attempted_at stays null) and the next poll picks it up again.
  const minAge = provider.minVisitAgeMs ?? 0;
  if (minAge > 0 && now() - visit.created_at < minAge) {
    return { outcome: 'deferred', retryAfterMs: minAge - (now() - visit.created_at) };
  }

  // The spend caps: the last gate before money moves. A failed check is a no.
  const caps = spendCaps(env);
  let spend: SpendCheck | null = null;
  if (billable) {
    spend = await checkSpendCaps(db, provider.name, worstCaseCents, caps, now());
    if (!spend.ok) {
      await markResolveAttempted(db, visit.id, Date.now(), spend.reason);
      log.warn('resolution: paid call refused by the spend guard', { visit_id: visit.id, site_id: visit.site_id, reason: spend.reason, month_cents: spend.monthCents, day_cents: spend.dayCents, caps });
      try {
        const alerter = getSpendAlerter(env, log);
        if (spend.reason === 'spend_cap') await alerter.monthlyCapHit(db, log, spend.monthCents, caps, now());
        else if (spend.reason === 'daily_spend_cap') await alerter.dailyCapHit(db, log, spend.dayCents, caps, now());
        else log.error('resolution: spend check failed; refusing to call the provider', { visit_id: visit.id });
      } catch (err) {
        log.error('resolution: spend alert failed', errorFields(err));
      }
      await back();
      return { outcome: 'skipped', skipReason: spend.reason };
    }
  }

  const input = toResolveInput(visit, site);
  // Claim the lookup before paying: two runs that overlap (a slow cron, the admin "resolve" button,
  // two visits of one visitor) must never both call, bill, and send a card. The loser leaves the
  // visit unmarked, so a later run decides it once the winner is done.
  const requestId = await claimIdentityRequest(
    db,
    { visitId: visit.id, siteId: visit.site_id, visitorId: visit.visitor_id, provider: provider.name, requestPayload: requestPayloadForStorage(input), billable },
    now(),
  );
  if (!requestId) {
    log.info('resolution: another run holds this visitor\'s lookup; leaving the visit for later', { visit_id: visit.id, visitor_id: visit.visitor_id, site_id: visit.site_id });
    return { outcome: 'busy' };
  }
  const rlog = log.child({ identity_request_id: requestId, provider: provider.name, visit_id: visit.id, site_id: visit.site_id });

  let result: ResolveResult;
  try {
    result = await provider.resolve(input);
  } catch (err) {
    result = { status: 'error', error: err instanceof Error ? err.message : String(err) };
    rlog.error('resolution: provider threw', errorFields(err));
  }

  // Opt-outs: a match is thrown away before it becomes a lead if any of the person's emails,
  // phones or home address belongs to someone who asked us to stop, not just the email on the lead.
  let optedOut = false;
  if (result.status === 'resolved' && result.lead) {
    const keys = await personKeys({
      emails: [result.lead.email, ...(result.emails ?? [])],
      phones: [result.lead.phone, ...(result.phones ?? [])],
      last_name: result.lead.last_name,
      address_line1: result.lead.address_line1,
      zip: result.lead.zip,
    });
    optedOut = await isPersonOptedOut(db, keys);
  }

  const costCents = typeof result.cost_cents === 'number' ? Math.round(result.cost_cents) : null;
  // Gates 2 and 3 on a match. Opt-out keeps its own path (nothing about the person is kept).
  const leadCheck = result.status === 'resolved' && result.lead ? leadGate({ state: result.lead.state ?? null, optedOut, gpc: visit.gpc === 1, visitRegion: visit.region }, allowed) : null;
  if (leadCheck && !leadCheck.ok && leadCheck.reason !== 'opted_out') {
    // Withheld: the lookup was billed, so the request row keeps its cost and counts for the 30-day rule.
    // The raw answer stays at most WITHHELD_RETENTION_DAYS, then the cron scrubs it (scrubWithheldResponses).
    await db.batch([
      completeIdentityRequestStmt(db, requestId, { status: 'resolved', responsePayload: { ...asObject(result.raw), withheld: leadCheck.reason }, costCents }),
      markResolveAttemptedStmt(db, visit.id, Date.now(), leadCheck.reason),
    ]);
    rlog.info('resolution: match withheld, not delivered', { reason: leadCheck.reason, cost_cents: costCents });
    await alertSpend(env, rlog, billable, spend, costCents, caps, now());
    await back();
    return { outcome: 'withheld', identityRequestId: requestId, skipReason: leadCheck.reason };
  }
  if (optedOut) {
    await completeIdentityRequest(db, requestId, { status: 'no_match', responsePayload: { opted_out: true }, costCents });
    await markResolveAttempted(db, visit.id, Date.now(), 'opted_out');
    await rememberOptedOutVisitor(db, visit.site_id, visit.visitor_id); // so the next visit is skipped before we pay
    rlog.info('resolution: match discarded, person opted out');
    return { outcome: 'opted_out', identityRequestId: requestId };
  }
  // Does the match fit where the visit came from? Then the floor: below it, no lead.
  const match = result.status === 'resolved' ? (result.lead ?? null) : null;
  const located = match ? locationAdjusted(typeof result.confidence === 'number' ? result.confidence : 0.5, match, visit) : null;
  const floor = minConfidence(env.MIN_CONFIDENCE);
  if (located) rlog.info('resolution: confidence', { provider_confidence: result.confidence ?? null, confidence: located.confidence, location: located.location, floor });
  const lowConfidence = located !== null && located.confidence < floor;
  // A re-check that found nothing more than the partial lead we already sent: no second card.
  const nothingNew = match !== null && history.hasLead && isPartialLead({ first_name: match.first_name ?? null, last_name: match.last_name ?? null, address_line1: match.address_line1 ?? null });
  const newLead = match && located && !lowConfidence && !nothingNew
    ? await insertLeadStmt(db, {
        siteId: visit.site_id,
        visitorId: visit.visitor_id,
        identityRequestId: requestId,
        fields: match,
        confidence: located.confidence,
        contacts: { emails: result.emails, phones: result.phones },
      })
    : null;

  // The answer, the lead and the visit mark go in together, so a run that stops here never leaves
  // a paid match without its lead. If the batch never lands, the pending row counts at worst case.
  await db.batch([
    completeIdentityRequestStmt(db, requestId, {
      status: result.status,
      responsePayload: result.status === 'error' ? { error: result.error ?? 'unknown', raw: result.raw ?? null } : (result.raw ?? null),
      costCents,
    }),
    ...(newLead ? newLead.stmts : []),
    markResolveAttemptedStmt(db, visit.id),
  ]);
  if (costCents !== null) rlog.info('resolution: provider cost', { cost_cents: costCents, status: result.status });
  await alertSpend(env, rlog, billable, spend, costCents, caps, now());

  if (!match) {
    rlog.info('resolution: done', { status: result.status, error: result.error });
    await back();
    return { outcome: result.status, identityRequestId: requestId };
  }
  if (lowConfidence) {
    rlog.info('resolution: match below the confidence floor; no lead');
    await back();
    return { outcome: 'low_confidence', identityRequestId: requestId };
  }
  if (!newLead) {
    rlog.info('resolution: re-check found no more than the lead we have; no new card');
    await back();
    return { outcome: 'resolved', identityRequestId: requestId };
  }

  const lead: LeadRow = newLead.row;
  rlog.info('resolution: lead created', { lead_id: lead.id, confidence: lead.confidence });

  // Hail before delivery, so the card can show it. Map the home address first so distance is from the house.
  const hail = await scoreLead(env, db, visit, lead, rlog);

  // Over the plan's monthly household limit: keep the lead, do not deliver it. The terms promise exactly this.
  const used = account.monthly_quota > 0 ? await countAccountLeadsSince(db, account.id, monthStartMs()) : 0;
  const overQuota = account.monthly_quota > 0 && used > account.monthly_quota;
  const channels = channelOverride ? [channelOverride] : getDeliveryChannels(env, db, site, visit, provider.name, rlog, hail);
  for (const channel of channels) await deliverLead(db, lead, channel, rlog, Date.now(), overQuota ? 'over_quota' : null);
  if (overQuota) rlog.warn('delivery skipped: account over monthly quota', { account_id: account.id, used, quota: account.monthly_quota });

  return { outcome: 'resolved', leadId: lead.id, identityRequestId: requestId };
}

/**
 * Geocode the lead's home (best effort), then write the address-level score and return the
 * card's hail facts. Never throws: a failure here must not stop the lead from being delivered.
 */
async function scoreLead(env: Env, db: D1Database, visit: VisitRow, lead: LeadRow, log: Logger): Promise<HailFacts | undefined> {
  try {
    const point = await getGeocoder(env).geocode(lead);
    if (point) {
      await updateLeadLocation(db, lead.id, point.lat, point.lng);
      lead.lat = point.lat;
      lead.lng = point.lng;
    }
    const { result, events } = await scoreAndStore(db, visit, lead, Date.now(), hailSourceName(env));
    log.info('scoring: address-level', { lead_id: lead.id, score: result.score, geocoded: !!point, hail_days_since: result.hail_days_since });
    return hailFacts(result, events);
  } catch (err) {
    log.error('scoring: address-level failed', errorFields(err));
    return undefined;
  }
}

/**
 * "They're back": the visitor already has a lead and just started a new visit. One email per
 * visitor per day, on the site's lead email. Never throws; a failed send is a failed delivery row.
 */
async function alertIfReturning(env: Env, site: Site, visit: VisitRow, providerName: string, log: Logger, now: number): Promise<void> {
  try {
    if (!site.leadEmail) return;
    if (!(await isFirstViewOfSession(env.DB, visit))) return;
    if (await hadDeliverySince(env.DB, site.id, visit.visitor_id, RETURN_ALERT_CHANNEL, now - DAY_MS)) return;
    // Only a lead the business already received. One held back (over quota) must not go out here either.
    const lead = await latestLeadForVisitor(env.DB, site.id, visit.visitor_id, now - 30 * DAY_MS, providerName, { delivered: true });
    if (!lead) return;
    const pages = await listRecentPathsForVisitor(env.DB, site.id, visit.visitor_id, DAY_MS, now);
    const channel = getReturnAlertChannel(env, env.DB, site, pages, providerName, log);
    if (!channel) return;
    await deliverLead(env.DB, lead, channel, log.child({ visit_id: visit.id }), now);
  } catch (err) {
    log.error('resolution: return alert failed', { visit_id: visit.id, ...errorFields(err) });
  }
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { raw: v ?? null };
}

/** Money moved: say so at 50% and 80% of the monthly cap, once each per month. Never throws. */
async function alertSpend(env: Env, log: Logger, billable: boolean, spend: SpendCheck | null, costCents: number | null, caps: ReturnType<typeof spendCaps>, now: number): Promise<void> {
  if (!billable || !spend?.ok || costCents === null || costCents <= 0) return;
  try {
    await getSpendAlerter(env, log).checkThresholds(env.DB, log, spend.monthCents + costCents, caps, now);
  } catch (err) {
    log.error('resolution: spend alert failed', errorFields(err));
  }
}

/** How long one poll run keeps taking visits. Under the 5-minute cron; an overlap is safe anyway (the claim). */
export const POLL_BUDGET_MS = 4 * 60 * 1000;
/** Visits taken from each site per round. */
export const POLL_PER_SITE = 10;
/**
 * The most visits one run handles. One Worker run gets about 1,000 database queries and 200 ms of
 * CPU (wrangler.toml), and a visit can take a dozen queries, so a run stops here and the rest wait
 * five minutes. Queue mode is the way past it.
 */
export const POLL_MAX_VISITS = 60;

export interface PollOptions {
  /** Stop starting new visits after this long. Default POLL_BUDGET_MS. */
  budgetMs?: number;
  /** Stop after this many visits. Default POLL_MAX_VISITS. */
  maxVisits?: number;
  perSite?: number;
  /** Only visits created before this. Queue mode sweeps just the ones the queue lost. */
  createdBefore?: number;
  clock?: () => number;
}

/**
 * Poll mode: process the visits the step has not looked at yet, oldest first, in rounds. Each round
 * takes up to `perSite` visits from every site and goes round-robin across them, so one busy site
 * (or a bot flood) cannot make every other site wait. Rounds go on until nothing is left or the
 * time budget is spent. Each visit is looked at once per run; a deferred one waits for the next run.
 * Returns how many it touched.
 */
export async function pollUnresolvedVisits(env: Env, log: Logger, opts: PollOptions = {}): Promise<number> {
  const clock = opts.clock ?? (() => Date.now());
  const deadline = clock() + (opts.budgetMs ?? POLL_BUDGET_MS);
  const perSite = opts.perSite ?? POLL_PER_SITE;
  const maxVisits = opts.maxVisits ?? POLL_MAX_VISITS;
  const createdBefore = opts.createdBefore;
  // Where each site's next round starts. A site leaves the map once it has nothing more.
  const cursors = new Map<string, { createdAt: number; id: string } | null>();
  for (const siteId of await listSitesWithUnresolvedVisits(env.DB, createdBefore)) cursors.set(siteId, null);
  // One provider instance per site per run, so Delivr's bill breaker counts across the run.
  const providers = new Map<string, IdentityProvider>();
  let n = 0;
  while (cursors.size > 0) {
    const round: VisitRow[][] = [];
    for (const [siteId, after] of cursors) {
      const visits = await listUnresolvedVisits(env.DB, perSite, { siteId, after, createdBefore });
      const last = visits[visits.length - 1];
      if (visits.length < perSite || !last) cursors.delete(siteId);
      else cursors.set(siteId, { createdAt: last.created_at, id: last.id });
      round.push(visits);
    }
    for (let i = 0; i < perSite; i++) {
      for (const visits of round) {
        const v = visits[i];
        if (!v) continue;
        if (clock() >= deadline || n >= maxVisits) {
          log.warn('resolution: poll stopped at its budget; the rest wait for the next run', { processed: n, out_of: n >= maxVisits ? 'visits' : 'time' });
          return n;
        }
        try {
          let provider = providers.get(v.site_id);
          if (!provider) {
            const site = await getSiteById(env.DB, v.site_id);
            provider = getProvider(env, site ?? undefined);
            providers.set(v.site_id, provider);
          }
          await processVisit(env, v.id, log, provider);
        } catch (err) {
          log.error('resolution: unhandled failure', { visit_id: v.id, ...errorFields(err) });
        }
        n++;
      }
    }
  }
  return n;
}
