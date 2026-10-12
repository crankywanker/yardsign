/**
 * Worker entry point. Only the default handler is exported here: workerd treats
 * every named export of the entry module as a handler. The Hono app lives in app.ts.
 */
import { app, runScheduled } from './app';
import type { Env } from './env';
import { createLogger, errorFields } from './log';
import { processVisit } from './resolution';
import { queueRetryDelaySeconds, type ResolveMessage } from './scheduler';

export default {
  fetch: app.fetch,

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const log = createLogger({ req_id: `cron-${crypto.randomUUID()}`, cron: event.cron });
    ctx.waitUntil(runScheduled(env, event.cron, log).catch((err) => log.error('cron failed', errorFields(err))));
  },

  async queue(batch: MessageBatch<ResolveMessage>, env: Env): Promise<void> {
    const log = createLogger({ req_id: `queue-${crypto.randomUUID()}`, queue: batch.queue });
    for (const msg of batch.messages) {
      try {
        const r = await processVisit(env, msg.body.visitId, log.child({ visit_id: msg.body.visitId }));
        // Not ready yet (Delivr's 10 minutes), or another run holds the lookup: hand it back for later.
        // An ack here would drop the visit; nothing else queues it again.
        if (r.outcome === 'deferred' || r.outcome === 'busy') msg.retry({ delaySeconds: queueRetryDelaySeconds(r.retryAfterMs) });
        else msg.ack();
      } catch (err) {
        log.error('queue: processing failed, will retry', { visit_id: msg.body.visitId, ...errorFields(err) });
        msg.retry();
      }
    }
  },
};
