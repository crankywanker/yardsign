/**
 * How a stored visit gets to the resolution step. One small interface, two
 * implementations, picked by whether the queue binding exists:
 *
 *   QueueScheduler  Cloudflare Queues (paid plan). /collect sends a message; the
 *                   queue consumer in index.ts calls processVisit.
 *   PollScheduler   Free plan. /collect does nothing extra; the 5-minute cron picks up
 *                   visits where resolve_attempted_at IS NULL.
 */
import type { Env } from './env';

export interface ResolveMessage {
  visitId: string;
}

export interface ResolutionScheduler {
  readonly mode: 'queue' | 'poll';
  enqueue(visitId: string): Promise<void>;
}

export class QueueScheduler implements ResolutionScheduler {
  readonly mode = 'queue';
  constructor(private readonly queue: Queue<ResolveMessage>) {}
  async enqueue(visitId: string): Promise<void> {
    await this.queue.send({ visitId });
  }
}

export class PollScheduler implements ResolutionScheduler {
  readonly mode = 'poll';
  async enqueue(_visitId: string): Promise<void> {
    // The cron finds it by resolve_attempted_at IS NULL.
  }
}

export function getScheduler(env: Env): ResolutionScheduler {
  return env.RESOLVE_QUEUE ? new QueueScheduler(env.RESOLVE_QUEUE) : new PollScheduler();
}

/** Queue mode: how long a visit that is not ready yet waits before the queue hands it back. At least a minute, at most the queue's 12 hours. */
export function queueRetryDelaySeconds(retryAfterMs: number | undefined): number {
  return Math.min(43_200, Math.max(60, Math.ceil((retryAfterMs ?? 0) / 1000)));
}
