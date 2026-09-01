/**
 * Generation Pipeline Orchestrator
 *
 * Executes the full pipeline as a persisted job with streaming progress events:
 *
 *   USER INPUT → INGESTION → SOURCE EXTRACTION → ... → PUBLISHED COURSE
 *
 * Each stage updates the job record, emits a generation event (so the UI can
 * stream progress), and persists intermediate results so the UI recovers after
 * browser refresh. Idempotency keys block duplicate jobs.
 */
import { randomUUID } from 'node:crypto';
import {
  getGenerationJob,
  getGenerationJobByRequestKey,
  clearGenerationJobRequestKey,
  createGenerationJob,
  updateGenerationJob,
  createGenerationEvent,
  getLesson,
  listObjectives,
  listUnits,
  listAbandonedJobs,
  cancelGenerationJob,
  getUserEditsForEntity,
} from '../db/repo';
import {
  getCourse,
  getLatestKnowledgePackage,
  getObjective,
  listSourceDocuments,
  updateKnowledgePackage,
} from '../db/repo';
import { analyzeSources } from '../services/source-analysis';
import {
  generateBlueprint,
  persistBlueprint,
  loadPersistedBlueprint,
  generateLesson,
  generatePractice,
  generateAssessment,
  persistLesson,
  persistPracticeSet,
  persistAssessment,
} from '../services/course-generation';
import { runQa } from '../services/qa';
import { replanCourse } from '../services/replan';
import { createVersion } from '../services/versioning';
import { repairQaFailures } from '../services/revision';
import { JobKind, JobState, CurriculumBlueprint, LessonContent } from '../ai/types';
import { pipelineFailed } from '../lib/errors';

/* --------------------------------------------------------------- types ---- */

export interface StartJobInput {
  courseId: string;
  userId: string;
  kind: JobKind;
  requestKey?: string;
  input?: unknown;
}

export interface JobProgress {
  jobId: string;
  state: JobState;
  stage: string;
  progress: number;
  message: string;
}

/* ------------------------------------------------------- job management ---- */

async function emit(
  jobId: string,
  courseId: string,
  stage: string,
  message: string,
  ordinal: number,
  level: 'info' | 'warn' | 'error' = 'info',
): Promise<void> {
  createGenerationEvent({
    id: `ev_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    jobId,
    courseId,
    ordinal,
    stage,
    level,
    message,
  });
}

async function setState(
  jobId: string,
  state: JobState,
  stage: string,
  progress: number,
  message: string,
): Promise<void> {
  updateGenerationJob(jobId, { state, stage, progress, message });
}

/**
 * Start a job (idempotent by requestKey).
 */
export function startJob(input: StartJobInput): { jobId: string; created: boolean } {
  const existing = input.requestKey
    ? getGenerationJobByRequestKey(input.requestKey)
    : undefined;

  if (existing) {
    // A job that finished badly must not block the same request forever.
    // Retrying is the whole point, so let go of its request key and start a
    // fresh job instead of handing back the dead one.
    if (existing.state === 'FAILED' || existing.state === 'CANCELLED') {
      clearGenerationJobRequestKey(existing.id);
    } else {
      return { jobId: existing.id, created: false };
    }
  }

  const jobId = `job_${randomUUID().replace(/-/g, '').slice(0,24)}`;
  createGenerationJob({
    id: jobId,
    courseId: input.courseId,
    userId: input.userId,
    kind: input.kind,
    requestKey: input.requestKey,
    input: input.input ? JSON.stringify(input.input) : undefined,
  });

  return { jobId, created: true };
}

/* ------------------------------------------------------- job execution ---- */

/**
 * Execute an ANALYZE_SOURCE job.
 */
export async function executeAnalyzeSourceJob(jobId: string, courseId: string, documentIds: string[]): Promise<void> {
  await setState(jobId, 'ANALYZING', 'source_extraction', 0.1, 'Reading sources…');
  await emit(jobId, courseId, 'source_extraction', 'Reading sources…', 0);

  try {
    await setState(jobId, 'ANALYZING', 'source_extraction', 0.3, 'Extracting structure…');
    await emit(jobId, courseId, 'source_extraction', 'Extracting structure…', 1);

    await setState(jobId, 'ANALYZING', 'source_extraction', 0.6, 'Building knowledge package…');
    await emit(jobId, courseId, 'source_extraction', 'Building knowledge package…', 2);

    const result = await analyzeSources({ courseId, documentIds });

    await setState(jobId, 'COMPLETED', 'source_extraction', 1.0, 'Source analyzed.');
    updateGenerationJob(jobId, {
      state: 'COMPLETED',
      stage: 'source_extraction',
      progress: 1,
      finishedAt: Date.now(),
      result: JSON.stringify(result),
    });
    await emit(jobId, courseId, 'source_extraction', 'Source analyzed.', 3);
  } catch (err) {
    await setState(jobId, 'FAILED', 'source_extraction', 0, `Source analysis failed: ${(err as Error).message}`);
    updateGenerationJob(jobId, {
      state: 'FAILED',
      finishedAt: Date.now(),
      error: (err as Error).message,
    });
    throw pipelineFailed(`Source analysis failed: ${(err as Error).message}`);
  }
}

/**
 * Execute a BLUEPRINT job (generate + persist blueprint).
 */
export async function executeBlueprintJob(jobId: string, courseId: string): Promise<void> {
  await setState(jobId, 'PLANNING', 'blueprint', 0.1, 'Designing curriculum…');
  await emit(jobId, courseId, 'blueprint', 'Designing curriculum blueprint…', 0);

  try {
    const blueprint = await generateBlueprint(courseId);

    await setState(jobId, 'PLANNING', 'blueprint', 0.6, 'Persisting blueprint…');
    await persistBlueprint(courseId, blueprint);

    await setState(jobId, 'COMPLETED', 'blueprint', 1.0, 'Blueprint ready.');
    updateGenerationJob(jobId, {
      state: 'COMPLETED',
      stage: 'blueprint',
      progress: 1,
      finishedAt: Date.now(),
      result: JSON.stringify(blueprint),
    });
    await emit(jobId, courseId, 'blueprint', 'Curriculum blueprint ready.', 1);
  } catch (err) {
    await setState(jobId, 'FAILED', 'blueprint', 0, `Blueprint failed: ${(err as Error).message}`);
    updateGenerationJob(jobId, { state: 'FAILED', finishedAt: Date.now(), error: (err as Error).message });
    throw pipelineFailed(`Blueprint failed: ${(err as Error).message}`);
  }
}

/**
 * Execute a GENERATE_COURSE job (blueprint + lessons + practice + assessments
 * + QA + revision loop).
 */
export async function executeGenerateCourseJob(jobId: string, courseId: string): Promise<void> {
  let ordinal = 0;

  try {
    // 1. Blueprint (if not already present).
    await setState(jobId, 'PLANNING', 'blueprint', 0.05, 'Designing curriculum…');
    await emit(jobId, courseId, 'blueprint', 'Designing curriculum…', ordinal++);

    const existingUnits = listUnits(courseId);
    let blueprint: CurriculumBlueprint;
    if (existingUnits.length > 0) {
      // Blueprint already persisted; load the canonical snapshot.
      blueprint = loadPersistedBlueprint(courseId) ?? (await generateAndPersist(courseId));
    } else {
      blueprint = await generateAndPersist(courseId);
    }
    await emit(jobId, courseId, 'blueprint', 'Building prerequisite graph…', ordinal++);

    // 2. Generate lessons per unit/objective.
    const units = listUnits(courseId);
    const objectives = listObjectives(courseId);

    const totalObjectives = Math.max(objectives.length, 1);
    let doneObjectives = 0;

    await setState(jobId, 'GENERATING', 'lessons', 0.15, 'Generating lessons…');

    for (const unit of units) {
      checkCancelled(jobId);
      const unitObjectives = objectives.filter((o) => o.unitId === unit.id);
      if (unitObjectives.length === 0) continue;

      await emit(jobId, courseId, 'lessons', `Generating ${unit.title}…`, ordinal++);

      // One lesson per objective (simplified: group objectives per lesson).
      for (const obj of unitObjectives) {
        checkCancelled(jobId);
        const lessonContent = await generateLesson(courseId, unit.id, [obj.id], undefined, unitObjectives.indexOf(obj));
        persistLesson(courseId, unit.id, undefined, unitObjectives.indexOf(obj), [obj.id], lessonContent);
        doneObjectives++;
        const progress = 0.15 + 0.5 * (doneObjectives / totalObjectives);
        await setState(jobId, 'GENERATING', 'lessons', progress, `Generating lesson ${doneObjectives}/${totalObjectives}…`);
      }
    }

    // 3. Practice for EVERY objective (no artificial cap — cost control comes
    //    from bounded parallelism + caching at the AI layer, never by dropping
    //    objectives).
    await setState(jobId, 'GENERATING', 'practice', 0.72, 'Generating practice…');
    await emit(jobId, courseId, 'practice', 'Generating practice sets…', ordinal++);

    let donePractice = 0;
    for (const obj of objectives) {
      checkCancelled(jobId);
      const practice = await generatePractice(courseId, obj.id);
      persistPracticeSet(courseId, obj.id, undefined, practice);
      donePractice++;
      const progress = 0.72 + 0.1 * (donePractice / Math.max(objectives.length, 1));
      await setState(jobId, 'GENERATING', 'practice', progress, `Practice ${donePractice}/${objectives.length}…`);
    }

    await setState(jobId, 'GENERATING', 'assessments', 0.82, 'Generating assessments…');
    await emit(jobId, courseId, 'assessments', 'Generating assessments…', ordinal++);

    const unitObjectiveIds = objectives.map((o) => o.id);
    if (unitObjectiveIds.length > 0) {
      const assessment = await generateAssessment(courseId, unitObjectiveIds, 'unit');
      persistAssessment(courseId, undefined, assessment, unitObjectiveIds);
    }

    // 4. QA + bounded, targeted revision loop.
    let qa = await runQa(courseId, jobId, 1);
    let revisionPass = 0;
    const MAX_REVISION_PASSES = 3;

    while (qa.autoFixable > 0 && revisionPass < MAX_REVISION_PASSES) {
      checkCancelled(jobId);
      revisionPass++;
      await setState(jobId, 'REVISING', 'revision', 0.9 + 0.08 * revisionPass, `Fixing ${qa.autoFixable} issue(s)… (pass ${revisionPass})`);
      await emit(jobId, courseId, 'revision', `QA found ${qa.autoFixable} auto-fixable issue(s). Repairing (pass ${revisionPass})…`, ordinal++);

      const repair = await repairQaFailures(courseId, qa.autoFixableChecks);
      await emit(
        jobId, courseId, 'revision',
        `Repaired ${repair.repaired} issue(s), skipped ${repair.skipped}.`,
        ordinal++,
      );

      // If a pass repaired nothing, the remaining issues have no repair case
      // and never will. Running the loop again only burns another full QA pass
      // (including an AI call) to reach exactly the same place.
      if (repair.repaired === 0) {
        await emit(
          jobId, courseId, 'revision',
          'Nothing left that can be fixed automatically; stopping revision.',
          ordinal++, 'warn',
        );
        break;
      }

      // Re-run QA on the impacted curriculum.
      qa = await runQa(courseId, jobId, revisionPass + 1);
    }

    if (qa.autoFixable > 0 && revisionPass >= MAX_REVISION_PASSES) {
      await emit(jobId, courseId, 'revision', `Revision bound reached; ${qa.autoFixable} issue(s) remain (may need manual review).`, ordinal++, 'warn');
    }

    // Final verdict determines if the job is COMPLETED or FAILED.
    if (qa.verdict === 'FAILED') {
      await setState(jobId, 'FAILED', 'qa', 1.0, `QA verdict: ${qa.verdict} (${qa.blockingFailures} blocking failures).`);
      updateGenerationJob(jobId, {
        state: 'FAILED',
        stage: 'qa',
        progress: 1,
        finishedAt: Date.now(),
        error: `QA verdict: ${qa.verdict} (${qa.blockingFailures} blocking failures, ${qa.warnings} warnings).`,
      });
      await emit(jobId, courseId, 'qa', `QA verdict: ${qa.verdict}. Publishing blocked.`, ordinal++, 'error');
      throw pipelineFailed(`QA verdict: ${qa.verdict}.`);
    } else if (qa.verdict === 'REQUIRES_MANUAL_REVIEW') {
      // Still COMPLETED but flagged for manual review
      await setState(jobId, 'COMPLETED', 'qa', 1.0, `QA verdict: ${qa.verdict} — review required before publishing.`);
      updateGenerationJob(jobId, {
        state: 'COMPLETED',
        stage: 'qa',
        progress: 1,
        finishedAt: Date.now(),
        result: JSON.stringify({ qa, blueprint, verdict: qa.verdict }),
      });
      await emit(jobId, courseId, 'qa', `QA verdict: ${qa.verdict}. Manual review recommended.`, ordinal++, 'warn');
    } else {
      // PASSED or PASSED_WITH_WARNINGS
      await setState(jobId, 'COMPLETED', 'complete', 1.0, 'Course ready.');
      updateGenerationJob(jobId, {
        state: 'COMPLETED',
        stage: 'complete',
        progress: 1,
        finishedAt: Date.now(),
        result: JSON.stringify({ qa, blueprint, verdict: qa.verdict }),
      });
      await emit(jobId, courseId, 'complete', 'Course ready.', ordinal++);
    }
  } catch (err) {
    // A cancellation is the user's own decision, not a failure. Let it through
    // untouched, or the state gets overwritten to FAILED and the caller can no
    // longer tell the two apart.
    if (err instanceof JobCancelledError) throw err;
    await setState(jobId, 'FAILED', 'failed', 0, `Generation failed: ${(err as Error).message}`);
    updateGenerationJob(jobId, { state: 'FAILED', finishedAt: Date.now(), error: (err as Error).message });
    await emit(jobId, courseId, 'failed', `Failed: ${(err as Error).message}`, ordinal++, 'error');
    throw pipelineFailed(`Generation failed: ${(err as Error).message}`);
  }
}

/**
 * Generate a fresh blueprint and persist it (both entities and canonical snapshot).
 */
async function generateAndPersist(courseId: string): Promise<CurriculumBlueprint> {
  const blueprint = await generateBlueprint(courseId);
  await persistBlueprint(courseId, blueprint);
  return blueprint;
}

/**
 * Execute a REGENERATE_LESSON job.
 */
export async function executeRegenerateLessonJob(jobId: string, courseId: string, lessonId: string): Promise<void> {
  await setState(jobId, 'GENERATING', 'lesson_regeneration', 0.1, 'Regenerating lesson…');
  await emit(jobId, courseId, 'lesson_regeneration', 'Regenerating lesson…', 0);

  try {
    const lesson = getLesson(lessonId);
    if (!lesson) throw pipelineFailed(`Lesson ${lessonId} not found`);
    if (lesson.courseId !== courseId) throw pipelineFailed(`Lesson ${lessonId} does not belong to this course`);

    const objectiveIds = JSON.parse(lesson.objectiveIds ?? '[]') as string[];
    if (objectiveIds.length === 0) throw pipelineFailed('Lesson has no associated objectives');

    // Preserve user edits: fetch any user-edited fields and apply them after regeneration.
    const userEdits = getUserEditsForEntity(courseId, 'lesson', lessonId);
    const editMap = new Map<string, string>();
    for (const edit of userEdits) {
      if (edit.newValue != null) {
        editMap.set(edit.field, edit.newValue);
      }
    }

    await setState(jobId, 'GENERATING', 'lesson_regeneration', 0.5, 'Generating new lesson content…');
    await emit(jobId, courseId, 'lesson_regeneration', 'Generating new lesson content…', 1);

    const lessonContent = await generateLesson(courseId, lesson.unitId, objectiveIds, lesson.topicId ?? undefined, lesson.ordinal);

    // Apply user edits back to the regenerated content.
    let updatedContent = lessonContent;
    if (editMap.has('content')) {
      try {
        updatedContent = JSON.parse(editMap.get('content')!) as LessonContent;
      } catch { /* ignore malformed edit */ }
    }
    if (editMap.has('title')) {
      const newTitle = editMap.get('title');
      if (newTitle) {
        updatedContent = { ...updatedContent, sections: updatedContent.sections.map((s, i) => i === 0 ? { ...s, title: newTitle } : s) };
      }
    }
    if (editMap.has('summary')) {
      const newSummary = editMap.get('summary');
      if (newSummary) {
        updatedContent = { ...updatedContent, summary: newSummary };
      }
    }
    if (editMap.has('estimatedMinutes')) {
      const newEst = editMap.get('estimatedMinutes');
      if (newEst) {
        updatedContent = { ...updatedContent, estimatedMinutes: Number(newEst) };
      }
    }

    persistLesson(courseId, lesson.unitId, lesson.topicId ?? undefined, lesson.ordinal, objectiveIds, updatedContent);

    await setState(jobId, 'COMPLETED', 'lesson_regeneration', 1.0, 'Lesson regenerated.');
    updateGenerationJob(jobId, {
      state: 'COMPLETED',
      stage: 'lesson_regeneration',
      progress: 1,
      finishedAt: Date.now(),
      result: JSON.stringify({ lessonId }),
    });
    await emit(jobId, courseId, 'lesson_regeneration', 'Lesson regenerated.', 2);
  } catch (err) {
    await setState(jobId, 'FAILED', 'lesson_regeneration', 0, `Lesson regeneration failed: ${(err as Error).message}`);
    updateGenerationJob(jobId, {
      state: 'FAILED',
      finishedAt: Date.now(),
      error: (err as Error).message,
    });
    throw pipelineFailed(`Lesson regeneration failed: ${(err as Error).message}`);
  }
}

/**
 * Execute a QA job.
 */
/**
 * Execute a REPLAN job: fold newly added material into a course that is
 * already built.
 *
 * Order matters here. The course is snapshotted first, so a replan someone
 * dislikes is one restore away. Then the plan is merged rather than rebuilt,
 * which keeps every objective that survived — and with it the practice
 * history recorded against it. Only the genuinely new objectives are written
 * for; regenerating the whole course would be slower, cost more, and quietly
 * replace work that was already reviewed.
 */
export async function executeReplanJob(
  jobId: string,
  courseId: string,
  userId: string,
): Promise<void> {
  await setState(jobId, 'PLANNING', 'replan', 0.05, 'Saving a version first…');
  await emit(jobId, courseId, 'replan', 'Saving the current course as a version…', 0);

  try {
    createVersion(courseId, userId, {
      label: 'Before adding material',
      notes: 'Automatic snapshot taken before a replan.',
    });

    // Re-read every source, not just the new ones: the interpretation is one
    // document covering the whole course, and the new material may change what
    // the old material means.
    await setState(jobId, 'ANALYZING', 'replan', 0.15, 'Reading the material…');
    const documents = listSourceDocuments(courseId);
    if (documents.length === 0) throw pipelineFailed('There is no material to re-plan from.');

    await analyzeSources({ courseId, documentIds: documents.map((d) => d.id) });

    // Clicking "Update this course" IS the approval — the alternative is
    // stopping mid-job to ask again for something already asked for.
    const kp = getLatestKnowledgePackage(courseId);
    if (kp && kp.status !== 'approved') {
      updateKnowledgePackage(kp.id, { status: 'approved' });
    }

    await setState(jobId, 'PLANNING', 'replan', 0.25, 'Re-planning with the new material…');
    await emit(jobId, courseId, 'replan', 'Working out what changes…', 1);

    const summary = await replanCourse(courseId);

    await emit(
      jobId,
      courseId,
      'replan',
      `Kept ${summary.kept}, added ${summary.added}, removed ${summary.removed}.`,
      2,
    );

    // Only the new objectives need writing. Everything kept already has its
    // lesson and practice, and its mastery record is untouched.
    const total = Math.max(summary.addedObjectiveIds.length, 1);
    let done = 0;

    for (const objectiveId of summary.addedObjectiveIds) {
      checkCancelled(jobId);
      const objective = getObjective(objectiveId);
      if (!objective?.unitId) continue;

      const lessonContent = await generateLesson(courseId, objective.unitId, [objectiveId], undefined, objective.ordinal ?? 0);
      persistLesson(courseId, objective.unitId, undefined, objective.ordinal ?? 0, [objectiveId], lessonContent);

      const practice = await generatePractice(courseId, objectiveId);
      persistPracticeSet(courseId, objectiveId, undefined, practice);

      done++;
      await setState(
        jobId,
        'GENERATING',
        'replan',
        0.3 + 0.6 * (done / total),
        `Writing for new objective ${done}/${summary.addedObjectiveIds.length}…`,
      );
    }

    await setState(jobId, 'COMPLETED', 'replan', 1, 'Course updated.');
    updateGenerationJob(jobId, {
      state: 'COMPLETED',
      stage: 'replan',
      progress: 1,
      finishedAt: Date.now(),
      result: JSON.stringify(summary),
    });
    await emit(jobId, courseId, 'replan', 'Course updated with the new material.', 3);
  } catch (err) {
    // As above: cancelling is not failing.
    if (err instanceof JobCancelledError) throw err;
    await setState(jobId, 'FAILED', 'replan', 0, `Replan failed: ${(err as Error).message}`);
    updateGenerationJob(jobId, {
      state: 'FAILED',
      finishedAt: Date.now(),
      error: (err as Error).message,
    });
    throw pipelineFailed(`Replan failed: ${(err as Error).message}`);
  }
}

export async function executeQaJob(jobId: string, courseId: string): Promise<void> {
  await setState(jobId, 'VALIDATING', 'qa', 0.1, 'Running QA checks…');
  await emit(jobId, courseId, 'qa', 'Running QA checks…', 0);

  try {
    await setState(jobId, 'VALIDATING', 'qa', 0.5, 'Running deterministic checks…');
    await emit(jobId, courseId, 'qa', 'Running deterministic checks…', 1);

    const qa = await runQa(courseId, jobId, 1);

    await setState(jobId, 'COMPLETED', 'qa', 1.0, 'QA completed.');
    updateGenerationJob(jobId, {
      state: 'COMPLETED',
      stage: 'qa',
      progress: 1,
      finishedAt: Date.now(),
      result: JSON.stringify(qa),
    });
    await emit(jobId, courseId, 'qa', `QA completed: ${qa.totalChecks} checks, ${qa.failedChecks} failed.`, 2);
  } catch (err) {
    await setState(jobId, 'FAILED', 'qa', 0, `QA failed: ${(err as Error).message}`);
    updateGenerationJob(jobId, {
      state: 'FAILED',
      finishedAt: Date.now(),
      error: (err as Error).message,
    });
    throw pipelineFailed(`QA failed: ${(err as Error).message}`);
  }
}

/**
 * Execute a REVISE job (targeted revision based on QA failures).
 */
export async function executeReviseJob(jobId: string, courseId: string, runNumber = 1): Promise<void> {
  await setState(jobId, 'REVISING', 'revision', 0.1, 'Running targeted revisions…');
  await emit(jobId, courseId, 'revision', 'Running targeted revisions…', 0);

  try {
    // Get the latest QA results to find auto-fixable failures
    const qa = await runQa(courseId, jobId, runNumber);

    if (qa.autoFixable === 0) {
      await setState(jobId, 'COMPLETED', 'revision', 1.0, 'No auto-fixable issues found.');
      updateGenerationJob(jobId, {
        state: 'COMPLETED',
        stage: 'revision',
        progress: 1,
        finishedAt: Date.now(),
        result: JSON.stringify({ message: 'No auto-fixable issues found' }),
      });
      await emit(jobId, courseId, 'revision', 'No auto-fixable issues found.', 1);
      return;
    }

    await setState(jobId, 'REVISING', 'revision', 0.5, `Fixing ${qa.autoFixable} auto-fixable issue(s)…`);
    await emit(jobId, courseId, 'revision', `Fixing ${qa.autoFixable} auto-fixable issue(s)…`, 1);

    const repair = await repairQaFailures(courseId, qa.autoFixableChecks);

    await setState(jobId, 'COMPLETED', 'revision', 1.0, 'Revision completed.');
    updateGenerationJob(jobId, {
      state: 'COMPLETED',
      stage: 'revision',
      progress: 1,
      finishedAt: Date.now(),
      result: JSON.stringify(repair),
    });
    await emit(jobId, courseId, 'revision', `Repaired ${repair.repaired} issue(s), skipped ${repair.skipped}.`, 2);
  } catch (err) {
    await setState(jobId, 'FAILED', 'revision', 0, `Revision failed: ${(err as Error).message}`);
    updateGenerationJob(jobId, {
      state: 'FAILED',
      finishedAt: Date.now(),
      error: (err as Error).message,
    });
    throw pipelineFailed(`Revision failed: ${(err as Error).message}`);
  }
}

/**
 * Thrown when a job has been cancelled. Execution stops and the job's state is
 * already persisted as CANCELLED by the canceller; this just terminates the
 * current run without marking it FAILED.
 */
class JobCancelledError extends Error {
  constructor(jobId: string) {
    super(`Job ${jobId} was cancelled.`);
    this.name = 'JobCancelledError';
  }
}

/** Throw if the job has a pending cancellation request. */
function checkCancelled(jobId: string): void {
  const job = getGenerationJob(jobId);
  if (job && (job.cancelRequested === 1 || job.state === 'CANCELLED')) {
    throw new JobCancelledError(jobId);
  }
}

/**
 * Cancel a running job by marking it CANCELLED. Preserves already-persisted data
 * (we never delete partially generated entities); the UI reflects CANCELLED.
 */
export function cancelJob(jobId: string): { jobId: string; cancelled: boolean } {
  const job = cancelGenerationJob(jobId);
  return { jobId, cancelled: !!job && job.state === 'CANCELLED' };
}

/**
 * Generic dispatcher: run a job by its kind. Idempotent and cancellation-aware.
 */
export async function runJob(jobId: string): Promise<void> {
  const job = getGenerationJob(jobId);
  if (!job) throw pipelineFailed(`Job ${jobId} not found`);

  // Do not re-run a job already in a terminal state.
  if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.state)) {
    return;
  }

  // Mark started.
  updateGenerationJob(jobId, {
    state: job.kind === 'ANALYZE_SOURCE' ? 'ANALYZING' : 'QUEUED',
    startedAt: Date.now(),
    attempts: job.attempts + 1,
  });

  const input = job.input ? JSON.parse(job.input) : {};

  try {
    switch (job.kind) {
      case 'ANALYZE_SOURCE': {
        const docIds: string[] = Array.isArray(input.documentIds)
          ? input.documentIds
          : input.documentId
            ? [input.documentId]
            : [];
        await executeAnalyzeSourceJob(jobId, job.courseId, docIds);
        break;
      }
      case 'BLUEPRINT':
        await executeBlueprintJob(jobId, job.courseId);
        break;
      case 'GENERATE_COURSE':
        await executeGenerateCourseJob(jobId, job.courseId);
        break;
      case 'REGENERATE_LESSON': {
        const lessonId = input.lessonId;
        if (!lessonId) throw pipelineFailed('REGENERATE_LESSON job requires lessonId in input');
        await executeRegenerateLessonJob(jobId, job.courseId, lessonId);
        break;
      }
      case 'REPLAN': {
        const course = getCourse(job.courseId);
        if (!course) throw pipelineFailed('REPLAN job course not found');
        await executeReplanJob(jobId, job.courseId, course.userId);
        break;
      }
      case 'QA':
        await executeQaJob(jobId, job.courseId);
        break;
      case 'REVISE': {
        const runNumber = input.runNumber ?? 1;
        await executeReviseJob(jobId, job.courseId, runNumber);
        break;
      }
      default:
        throw pipelineFailed(`Unsupported job kind: ${job.kind}`);
    }
  } catch (err) {
    // Cancellation is not a failure — the job is already CANCELLED.
    if (err instanceof JobCancelledError) return;

    // Mark FAILED unless the job was cancelled concurrently.
    checkCancelled(jobId);
    updateGenerationJob(jobId, {
      state: 'FAILED',
      finishedAt: Date.now(),
      error: (err as Error).message,
    });
    throw err;
  }
}

const RECOVERABLE_STATES = ['QUEUED', 'ANALYZING', 'PLANNING', 'GENERATING', 'VALIDATING', 'REVISING'];

/** How long (ms) a job may remain in a non-terminal state before it's abandoned. */
const ABANDONED_AFTER_MS = 5 * 60 * 1000;

/**
 * Recovery: rescan for jobs stuck in a non-terminal state (e.g. the process
 * crashed mid-generation). For each abandoned job we mark it FAILED safely so it
 * can be retried by the user, rather than leaving it permanently stuck.
 */
export async function recoverAbandonedJobs(): Promise<number> {
  const cutoff = Date.now() - ABANDONED_AFTER_MS;
  const abandoned = listAbandonedJobs(cutoff, RECOVERABLE_STATES);
  for (const job of abandoned) {
    updateGenerationJob(job.id, {
      state: 'FAILED',
      finishedAt: Date.now(),
      error: 'Job was interrupted (process restart). Retry to resume.',
      message: 'Job interrupted; retry to resume.',
    });
    createGenerationEvent({
      id: `ev_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      jobId: job.id,
      courseId: job.courseId,
      ordinal: 9999,
      stage: 'recovery',
      level: 'warn',
      message: 'Job marked failed after process interruption.',
    });
  }
  return abandoned.length;
}

/** Get current job progress for the UI. */
export function getJobProgress(jobId: string): JobProgress | null {
  const job = getGenerationJob(jobId);
  if (!job) return null;
  return {
    jobId: job.id,
    state: job.state as JobState,
    stage: job.stage ?? '',
    progress: job.progress,
    message: job.message ?? '',
  };
}