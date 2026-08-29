/**
 * Single-entry job runner.
 *
 * The worker and the HTTP fallback both pass through this module so a queued job
 * is atomically claimed before execution. The existing orchestrator remains the
 * source of truth for stage execution; this wrapper owns concurrency safety.
 */
import { claimQueuedJob, getGenerationJob, updateGenerationJob } from '../db/repo';
import { runJob } from './orchestrator';

const HEARTBEAT_MS = 30_000;

/**
 * Atomically claim a queued job, execute it, and keep its updatedAt timestamp
 * fresh while long-running AI work is in progress.
 */
export async function runClaimedJob(jobId: string): Promise<boolean> {
  const claimed = claimQueuedJob(jobId);
  if (!claimed) return false;

  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    timer = setInterval(() => {
      const current = getGenerationJob(jobId);
      if (!current || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(current.state)) return;
      // updatedAt is the existing durable heartbeat field. We intentionally do
      // not change the user-visible progress/message during a heartbeat.
      updateGenerationJob(jobId, {});
    }, HEARTBEAT_MS);

    await runJob(jobId);
    return true;
  } finally {
    if (timer) clearInterval(timer);
  }
}
