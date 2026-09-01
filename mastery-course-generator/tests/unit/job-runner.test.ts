import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getDb, resetDb } from '@/db';
import {
  createCourse,
  createGenerationJob,
  createUser,
  getGenerationJob,
  updateGenerationJob,
} from '@/db/repo';
import { claimJobForExecution } from '@/pipeline/job-runner';
import { startJob } from '@/pipeline/orchestrator';

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

describe('retrying a request that failed', () => {
  beforeEach(() => {
    resetDb();
    getDb();
  });

  function seedCourse() {
    const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
    const userId = `usr_${suffix}`;
    const courseId = `crs_${suffix}`;
    createUser({ id: userId, email: `${suffix}@example.com` });
    createCourse({ id: courseId, userId, title: 'Retry Test' });
    return { userId, courseId, requestKey: `analyze:${courseId}:doc-1` };
  }

  it('starts a fresh job once the previous one failed', () => {
    const { userId, courseId, requestKey } = seedCourse();

    const first = startJob({ courseId, userId, kind: 'ANALYZE_SOURCE', requestKey });
    expect(first.created).toBe(true);

    updateGenerationJob(first.jobId, { state: 'FAILED', error: 'boom' });

    // Without this, pressing Analyze again returned the dead job forever and
    // the only escape was re-uploading under new document ids.
    const second = startJob({ courseId, userId, kind: 'ANALYZE_SOURCE', requestKey });
    expect(second.created).toBe(true);
    expect(second.jobId).not.toBe(first.jobId);
  });

  it('still shares a job that is only in progress', () => {
    const { userId, courseId, requestKey } = seedCourse();

    const first = startJob({ courseId, userId, kind: 'ANALYZE_SOURCE', requestKey });
    const second = startJob({ courseId, userId, kind: 'ANALYZE_SOURCE', requestKey });

    expect(second.created).toBe(false);
    expect(second.jobId).toBe(first.jobId);
  });
});
