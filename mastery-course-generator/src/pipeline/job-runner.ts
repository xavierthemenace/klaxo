/**
 * Single-entry job runner.
 *
 * Both the worker and the HTTP fallback pass through this module. A queued job
 * is claimed with one atomic UPDATE before execution, so two processes can see
 * the same queue entry but only one can own it.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '../db';
import { getGenerationJob, updateGenerationJob } from '../db/repo';
import { runJob } from './orchestrator';

const HEARTBEAT_MS = 30_000;

function claimQueuedJob(jobId: string): boolean {
  const now = Date.now();
  const result = getDb().run(sql`
    UPDATE generation_jobs
    SET state = 'ANALYZING',
        started_at = COALESCE(started_at, ${now}),
        updated_at = ${now}
    WHERE id = ${jobId}
      AND state = 'QUEUED'
      AND cancel_requested = 0
  `);

  return Number(result.changes ?? 0) === 1;
}

export async function runClaimedJob(jobId: string): Promise<boolean> {
  if (!claimQueuedJob(jobId)) return false;

  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    timer = setInterval(() => {
      const current = getGenerationJob(jobId);
      if (!current || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(current.state)) return;
      updateGenerationJob(jobId, {});
    }, HEARTBEAT_MS);

    await runJob(jobId);
    return true;
  } finally {
    if (timer) clearInterval(timer);
  }
}
