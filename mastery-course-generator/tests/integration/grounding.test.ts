/**
 * Integration test: the three things a course is supposed to be grounded in.
 *
 * Each of these was broken while every test passed, because the mock fixtures
 * were tidier than a real model reply:
 *
 *   - the prerequisite graph (no dependency row was ever written),
 *   - source citations (every objective resolved to "inferred from source set"),
 *   - assessment questions (none carried an objective, so none could be answered).
 *
 * They are asserted here against real persisted rows.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

process.env.AI_DEV_MODE = 'true';
process.env.FCC_SERVER_API_KEY = '';
process.env.DATABASE_FILE = ':memory:';

import { resetDb, getDb } from '@/db';
import {
  createCourse,
  createGenerationJob,
  createUser,
  listAssessments,
  listDependencies,
  listObjectives,
  listProvenanceForEntity,
  listQuestions,
} from '@/db/repo';
import { ingestPrompt } from '@/services/ingestion';
import { analyzeSource, fragmentIndexFromRef } from '@/services/source-analysis';
import { generateBlueprint, persistBlueprint } from '@/services/course-generation';
import { executeGenerateCourseJob } from '@/pipeline/orchestrator';

const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

describe('a generated course is actually grounded', () => {
  let courseId: string;

  beforeAll(async () => {
    resetDb();
    getDb();

    const userId = newId('usr');
    createUser({ id: userId, email: `grounding-${Date.now()}@example.com` });

    courseId = newId('crs');
    createCourse({ id: courseId, userId, title: 'Grounding Course', subjectDomain: 'general' });

    const src = await ingestPrompt(courseId, 'Teach differentiation, starting from limits.');
    await analyzeSource({ courseId, documentId: src.documentId });

    const blueprint = await generateBlueprint(courseId);
    await persistBlueprint(courseId, blueprint);

    const jobId = newId('job');
    createGenerationJob({ id: jobId, courseId, userId, kind: 'GENERATE_COURSE' });
    await executeGenerateCourseJob(jobId, courseId);
  }, 60_000);

  afterAll(() => {
    resetDb();
  });

  it('writes the prerequisite graph the blueprint asked for', () => {
    const dependencies = listDependencies(courseId);
    expect(dependencies.length).toBeGreaterThan(0);

    // Both ends must be real objectives, or the two blocking QA checks that
    // walk this graph have nothing to walk.
    const objectiveIds = new Set(listObjectives(courseId).map((o) => o.id));
    for (const dep of dependencies) {
      expect(objectiveIds.has(dep.objectiveId)).toBe(true);
      expect(objectiveIds.has(dep.prerequisiteId)).toBe(true);
    }
  });

  it('links objectives back to the source fragment they came from', () => {
    const objectives = listObjectives(courseId);
    expect(objectives.length).toBeGreaterThan(0);

    const fragmentLinked = objectives.some((obj) =>
      listProvenanceForEntity('objective', obj.id).some((p) => p.fragmentId),
    );
    expect(fragmentLinked).toBe(true);
  });

  it('gives every assessment question an objective, so it can be answered', () => {
    const assessments = listAssessments(courseId);
    expect(assessments.length).toBeGreaterThan(0);

    const assessmentIds = new Set(assessments.map((a) => a.id));
    const assessmentQuestions = listQuestions(courseId).filter(
      (q) => q.assessmentId && assessmentIds.has(q.assessmentId),
    );

    expect(assessmentQuestions.length).toBeGreaterThan(0);
    for (const q of assessmentQuestions) {
      // The answer-submission API rejects a question without one.
      expect(q.objectiveId).toBeTruthy();
    }
  });
});

describe('fragmentIndexFromRef', () => {
  it('reads the label the model was shown', () => {
    expect(fragmentIndexFromRef('source-0')).toBe(0);
    expect(fragmentIndexFromRef('source-12')).toBe(12);
    expect(fragmentIndexFromRef('frag-3')).toBe(3);
    expect(fragmentIndexFromRef('[source-4]')).toBe(4);
  });

  it('still accepts a bare index', () => {
    expect(fragmentIndexFromRef('2')).toBe(2);
    expect(fragmentIndexFromRef(5)).toBe(5);
  });

  it('returns a miss rather than NaN for anything else', () => {
    expect(fragmentIndexFromRef('the introduction')).toBe(-1);
    expect(fragmentIndexFromRef(null)).toBe(-1);
  });
});
