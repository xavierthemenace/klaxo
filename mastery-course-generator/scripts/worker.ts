/**
 * Durable generation worker.
 *
 * Polls for queued jobs and executes them through the same atomic claim/heartbeat
 * path used by the development HTTP fallback. Multiple workers may safely poll
 * the same database; only one can claim a given job.
 */
import { getDb } from '../src/db';
import { listQueuedJobs } from '../src/db/repo';
import { recoverAbandonedJobs } from '../src/pipeline/orchestrator';
import { runClaimedJob } from '../src/pipeline/job-runner';
import { logger } from '../src/lib/logger';
import { getEnv } from '../src/lib/env';

let shuttingDown = false;

async function tick(): Promise<void> {
  if (shuttingDown) return;
  await recoverAbandonedJobs();
  const { WORKER_CONCURRENCY } = getEnv();
  const queued = listQueuedJobs(Math.max(WORKER_CONCURRENCY * 2, WORKER_CONCURRENCY));
  let cursor = 0;

  async function workerSlot(): Promise<void> {
    while (!shuttingDown) {
      const job = queued[cursor++];
      if (!job) return;
      try {
        await runClaimedJob(job.id);
      } catch (err) {
        logger.error('Worker job failed', {
          jobId: job.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  await Promise.all(Array.from({ length: WORKER_CONCURRENCY }, () => workerSlot()));
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Worker shutting down', { signal });
  // Jobs are checkpointed and heartbeating; any uncompleted work is recovered
  // after a process restart rather than being discarded.
  getDb();
}

async function main(): Promise<void> {
  const env = getEnv();
  getDb();
  logger.info('Worker started', {
    pollMs: env.WORKER_POLL_MS,
    concurrency: env.WORKER_CONCURRENCY,
  });

  process.once('SIGTERM', () => void shutdown('SIGTERM').then(() => process.exit(0)));
  process.once('SIGINT', () => void shutdown('SIGINT').then(() => process.exit(0)));

  while (!shuttingDown) {
    try {
      await tick();
    } catch (err) {
      logger.error('Worker tick failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (!shuttingDown) {
      await new Promise((resolve) => setTimeout(resolve, env.WORKER_POLL_MS));
    }
  }
}

void main();
