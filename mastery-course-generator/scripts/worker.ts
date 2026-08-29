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

const POLL_MS = 1500;

async function tick(): Promise<void> {
  await recoverAbandonedJobs();
  const queued = listQueuedJobs(10);

  await Promise.all(
    queued.map(async (job) => {
      try {
        await runClaimedJob(job.id);
      } catch (err) {
        logger.error('Worker job failed', {
          jobId: job.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );
}

async function main(): Promise<void> {
  getDb();
  logger.info('Worker started: polling for QUEUED generation jobs.');

  for (;;) {
    try {
      await tick();
    } catch (err) {
      logger.error('Worker tick failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

void main();
