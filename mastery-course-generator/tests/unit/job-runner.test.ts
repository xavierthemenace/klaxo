import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getDb, resetDb } from '@/db';
import { createCourse, createGenerationJob, createUser, getGenerationJob } from '@/db/repo';
import { claimJobForExecution } from '@/pipeline/job-runner';

describe('job runner concurrency', () => {
  beforeEach(() => {
    resetDb();
    getDb();
  });

  it('allows exactly one claimant for the same queued job', () => {
    const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
    const userId = `usr_${suffix}`;
    const courseId = `crs_${suffix}`;
    const jobId = `job_${suffix}`;

    createUser({ id: userId, email: `${suffix}@example.com` });
    createCourse({ id: courseId, userId, title: 'Concurrency Test' });
    createGenerationJob({ id: jobId, courseId, userId, kind: 'GENERATE_COURSE' });

    const first = claimJobForExecution(jobId);
    const second = claimJobForExecution(jobId);

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(getGenerationJob(jobId)?.state).toBe('ANALYZING');
  });
});
