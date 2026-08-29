/**
 * Single-entry job runner.
 *
 * The web fallback and durable worker share this path. A small lease table makes
 * ownership independent of the orchestrator's stage-state transitions, so a job
 * cannot be picked twice even when the orchestrator briefly reports QUEUED.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb } from '../db';
import { getGenerationJob, updateGenerationJob } from '../db/repo';
import { runJob } from './orchestrator';

const HEARTBEAT_MS = 30_000;
const LEASE_STALE_MS = 10 * 60 * 1000;

function ensureLeaseTable(): void {
  getDb().run(sql`
    CREATE TABLE IF NOT EXISTS generation_job_leases (
      job_id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      heartbeat_at INTEGER NOT NULL
    )
  `);
}

function claimLease(jobId: string): string | null {
  ensureLeaseTable();
  const now = Date.now();
  const owner = randomUUID();

  // A worker that died without cleanup leaves a lease behind. Its heartbeat is
  // only reclaimable after a generous window, which is longer than the normal
  // heartbeat interval and avoids normal concurrent execution races.
  getDb().run(sql`
    DELETE FROM generation_job_leases
    WHERE job_id = ${jobId}
      AND heartbeat_at < ${now - LEASE_STALE_MS}
  `);

  const result = getDb().run(sql`
    INSERT OR IGNORE INTO generation_job_leases (job_id, owner, heartbeat_at)
    VALUES (${jobId}, ${owner}, ${now})
  `);

  if (Number(result.changes ?? 0) !== 1) return null;

  // Mark the job active immediately. The orchestrator may change its public
  // stage later, but the lease remains the authoritative execution lock.
  getDb().run(sql`
    UPDATE generation_jobs
    SET state = 'ANALYZING',
        started_at = COALESCE(started_at, ${now}),
        updated_at = ${now}
    WHERE id = ${jobId}
      AND cancel_requested = 0
  `);

  return owner;
}

/** Atomically claim a queued job. Exported for concurrency regression tests. */
export function claimJobForExecution(jobId: string): boolean {
  return claimLease(jobId) !== null;
}

function heartbeat(jobId: string, owner: string): boolean {
  const now = Date.now();
  const result = getDb().run(sql`
    UPDATE generation_job_leases
    SET heartbeat_at = ${now}
    WHERE job_id = ${jobId} AND owner = ${owner}
  `);
  if (Number(result.changes ?? 0) !== 1) return false;

  const current = getGenerationJob(jobId);
  if (current && !['COMPLETED', 'FAILED', 'CANCELLED'].includes(current.state)) {
    updateGenerationJob(jobId, {});
  }
  return true;
}

function releaseLease(jobId: string, owner: string): void {
  getDb().run(sql`
    DELETE FROM generation_job_leases
    WHERE job_id = ${jobId} AND owner = ${owner}
  `);
}

export async function runClaimedJob(jobId: string): Promise<boolean> {
  const owner = claimLease(jobId);
  if (!owner) return false;

  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    timer = setInterval(() => {
      try {
        heartbeat(jobId, owner);
      } catch {
        // The orchestrator will surface actual DB failures; heartbeat failures
        // should not create an unhandled timer rejection.
      }
    }, HEARTBEAT_MS);

    await runJob(jobId);
    return true;
  } finally {
    if (timer) clearInterval(timer);
    releaseLease(jobId, owner);
  }
}
