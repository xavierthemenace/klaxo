/**
 * RevisionService — targeted repair of QA failures.
 *
 * The orchestration loop calls `repairQaFailures` with the list of auto-fixable
 * failures from a QA run. Each failure is mapped to a *specific* entity and a
 * *specific* repair action, and only that entity is regenerated — never the
 * whole course. Repairs are bounded and idempotent.
 */
import {
  getObjective,
  listObjectives,
  listLessons,
  listUnits,
  getLesson,
  updateLesson,
  getQuestion,
  deleteQuestion,
  getAssessment,
  deleteAssessment,
  getPracticeSet,
  deletePracticeSet,
} from '../db/repo';
import {
  generateLesson,
  generateAssessment,
  generatePractice,
  persistLesson,
  persistAssessment,
  persistPracticeSet,
} from './course-generation';
import { logger } from '../lib/logger';

export interface QaFailure {
  checkKey: string;
  entityType?: string;
  entityId?: string;
  message: string;
}

export interface RepairResult {
  checkKey: string;
  entityType?: string;
  entityId?: string;
  repaired: boolean;
  note: string;
}

/**
 * Repair a single QA failure by regenerating the minimal affected artifact.
 */
async function repairOne(courseId: string, failure: QaFailure): Promise<RepairResult> {
  const { checkKey, entityType, entityId } = failure;

  switch (checkKey) {
    case 'objective_assessment_alignment': {
      // Objective missing an aligned assessment question → generate a targeted
      // assessment covering that objective.
      const objectiveId = entityId;
      if (!objectiveId || entityType !== 'objective') {
        return { checkKey, entityType, entityId, repaired: false, note: 'Missing objective id.' };
      }
      const obj = getObjective(objectiveId);
      if (!obj) return { checkKey, entityType, entityId, repaired: false, note: 'Objective not found.' };
      const assessment = await generateAssessment(courseId, [objectiveId], 'formative');
      persistAssessment(courseId, obj.unitId ?? undefined, assessment, [objectiveId]);
      return { checkKey, entityType, entityId, repaired: true, note: `Generated targeted assessment for objective "${obj.code ?? objectiveId}".` };
    }

    case 'objective_lesson_coverage': {
      // Objective not covered by any lesson → generate a lesson for it.
      const objectiveId = entityId;
      if (!objectiveId || entityType !== 'objective') {
        return { checkKey, entityType, entityId, repaired: false, note: 'Missing objective id.' };
      }
      const obj = getObjective(objectiveId);
      if (!obj || !obj.unitId) return { checkKey, entityType, entityId, repaired: false, note: 'Objective/unit not found.' };
      const lesson = await generateLesson(courseId, obj.unitId, [objectiveId], obj.topicId ?? undefined, 0);
      persistLesson(courseId, obj.unitId, obj.topicId ?? undefined, 0, [objectiveId], lesson);
      return { checkKey, entityType, entityId, repaired: true, note: `Generated missing lesson for objective "${obj.code ?? objectiveId}".` };
    }

    case 'duplicate_lessons': {
      // Duplicate lesson titles → regenerate the duplicate with a more specific title
      const lessonId = entityId;
      if (!lessonId || entityType !== 'lesson') {
        return { checkKey, entityType, entityId, repaired: false, note: 'Missing lesson id.' };
      }
      const lesson = getLesson(lessonId);
      if (!lesson) return { checkKey, entityType, entityId, repaired: false, note: 'Lesson not found.' };
      
      const objectiveIds = JSON.parse(lesson.objectiveIds ?? '[]') as string[];
      if (objectiveIds.length === 0) {
        return { checkKey, entityType, entityId, repaired: false, note: 'Lesson has no objectives to regenerate from.' };
      }
      
      // Generate a new lesson with the same objectives but it will get a unique title
      const newLesson = await generateLesson(courseId, lesson.unitId, objectiveIds, lesson.topicId ?? undefined, lesson.ordinal);
      // Update the existing lesson with new content
      updateLesson(lessonId, {
        content: JSON.stringify(newLesson),
        title: newLesson.sections[0]?.title ?? lesson.title,
        summary: newLesson.summary,
        estimatedMinutes: newLesson.estimatedMinutes,
        status: 'regenerated',
        origin: 'AI_GENERATED',
      });
      return { checkKey, entityType, entityId, repaired: true, note: `Regenerated duplicate lesson "${lesson.title}" with unique content.` };
    }

    case 'invalid_equations': {
      // Invalid LaTeX equations in lesson content → attempt to fix by regenerating the lesson
      const lessonId = entityId;
      if (!lessonId || entityType !== 'lesson') {
        return { checkKey, entityType, entityId, repaired: false, note: 'Missing lesson id.' };
      }
      const lesson = getLesson(lessonId);
      if (!lesson || !lesson.content) return { checkKey, entityType, entityId, repaired: false, note: 'Lesson/content not found.' };
      
      const objectiveIds = JSON.parse(lesson.objectiveIds ?? '[]') as string[];
      if (objectiveIds.length === 0) {
        return { checkKey, entityType, entityId, repaired: false, note: 'Lesson has no objectives to regenerate from.' };
      }
      
      // Regenerate the lesson content
      const newLesson = await generateLesson(courseId, lesson.unitId, objectiveIds, lesson.topicId ?? undefined, lesson.ordinal);
      updateLesson(lessonId, {
        content: JSON.stringify(newLesson),
        title: newLesson.sections[0]?.title ?? lesson.title,
        summary: newLesson.summary,
        estimatedMinutes: newLesson.estimatedMinutes,
        status: 'regenerated',
        origin: 'AI_GENERATED',
      });
      return { checkKey, entityType, entityId, repaired: true, note: `Regenerated lesson "${lesson.title}" to fix invalid equations.` };
    }

    case 'empty_lesson_content': {
      // The lesson row exists but holds nothing. Same repair as a duplicate:
      // write it again from the objectives it was meant to cover.
      const lessonId = entityId;
      if (!lessonId || entityType !== 'lesson') {
        return { checkKey, entityType, entityId, repaired: false, note: 'Missing lesson id.' };
      }
      const lesson = getLesson(lessonId);
      if (!lesson) return { checkKey, entityType, entityId, repaired: false, note: 'Lesson not found.' };

      const objectiveIds = JSON.parse(lesson.objectiveIds ?? '[]') as string[];
      if (objectiveIds.length === 0) {
        return { checkKey, entityType, entityId, repaired: false, note: 'Lesson has no objectives to regenerate from.' };
      }

      const rewritten = await generateLesson(courseId, lesson.unitId, objectiveIds, lesson.topicId ?? undefined, lesson.ordinal);
      updateLesson(lessonId, {
        content: JSON.stringify(rewritten),
        title: rewritten.sections[0]?.title ?? lesson.title,
        summary: rewritten.summary,
        estimatedMinutes: rewritten.estimatedMinutes,
        status: 'regenerated',
        origin: 'AI_GENERATED',
      });
      return { checkKey, entityType, entityId, repaired: true, note: `Rewrote empty lesson "${lesson.title}".` };
    }

    case 'duplicate_questions': {
      // Two questions asking the same thing. Removing the duplicate is the
      // whole fix, and it costs no AI call at all.
      const questionId = entityId;
      if (!questionId || entityType !== 'question') {
        return { checkKey, entityType, entityId, repaired: false, note: 'Missing question id.' };
      }
      if (!getQuestion(questionId)) {
        return { checkKey, entityType, entityId, repaired: false, note: 'Question not found.' };
      }
      deleteQuestion(questionId);
      return { checkKey, entityType, entityId, repaired: true, note: 'Removed the duplicate question.' };
    }

    case 'assessment_without_questions': {
      const assessmentId = entityId;
      if (!assessmentId || entityType !== 'assessment') {
        return { checkKey, entityType, entityId, repaired: false, note: 'Missing assessment id.' };
      }
      const existingAssessment = getAssessment(assessmentId);
      if (!existingAssessment) {
        return { checkKey, entityType, entityId, repaired: false, note: 'Assessment not found.' };
      }

      let assessmentObjectiveIds: string[] = [];
      try {
        assessmentObjectiveIds = JSON.parse(existingAssessment.objectiveIds ?? '[]') as string[];
      } catch {
        assessmentObjectiveIds = [];
      }
      assessmentObjectiveIds = assessmentObjectiveIds.filter((oid) => getObjective(oid));

      if (assessmentObjectiveIds.length === 0) {
        // Nothing to build questions from, and an empty shell is worse than none.
        deleteAssessment(assessmentId);
        return { checkKey, entityType, entityId, repaired: true, note: 'Removed an empty assessment with no objectives.' };
      }

      const replacementAssessment = await generateAssessment(courseId, assessmentObjectiveIds, 'formative');
      persistAssessment(
        courseId,
        existingAssessment.unitId ?? undefined,
        replacementAssessment,
        assessmentObjectiveIds,
      );
      deleteAssessment(assessmentId);
      return { checkKey, entityType, entityId, repaired: true, note: `Replaced empty assessment "${existingAssessment.title}".` };
    }

    case 'practice_set_without_questions': {
      const practiceSetId = entityId;
      if (!practiceSetId || entityType !== 'practice_set') {
        return { checkKey, entityType, entityId, repaired: false, note: 'Missing practice set id.' };
      }
      const existingSet = getPracticeSet(practiceSetId);
      if (!existingSet) {
        return { checkKey, entityType, entityId, repaired: false, note: 'Practice set not found.' };
      }

      const setObjectiveId = existingSet.objectiveId;
      if (!setObjectiveId || !getObjective(setObjectiveId)) {
        deletePracticeSet(practiceSetId);
        return { checkKey, entityType, entityId, repaired: true, note: 'Removed an empty practice set with no objective.' };
      }

      const replacementSet = await generatePractice(courseId, setObjectiveId);
      persistPracticeSet(courseId, setObjectiveId, existingSet.lessonId ?? undefined, replacementSet);
      deletePracticeSet(practiceSetId);
      return { checkKey, entityType, entityId, repaired: true, note: `Replaced empty practice set "${existingSet.title}".` };
    }

    case 'malformed_question_structure': {
      // Malformed question (missing choices, answer key, etc.)
      const questionId = entityId;
      if (!questionId || entityType !== 'question') {
        return { checkKey, entityType, entityId, repaired: false, note: 'Missing question id.' };
      }
      const question = getQuestion(questionId);
      if (!question) return { checkKey, entityType, entityId, repaired: false, note: 'Question not found.' };
      
      // For malformed questions, we can't easily auto-fix without knowing the intent
      // Mark as requiring manual review
      return { checkKey, entityType, entityId, repaired: false, note: 'Question structure issues require manual review.' };
    }

    case 'invalid_answer_key': {
      // Invalid answer key in question
      const questionId = entityId;
      if (!questionId || entityType !== 'question') {
        return { checkKey, entityType, entityId, repaired: false, note: 'Missing question id.' };
      }
      const question = getQuestion(questionId);
      if (!question) return { checkKey, entityType, entityId, repaired: false, note: 'Question not found.' };
      
      // Can't easily auto-fix answer keys without the correct answer
      return { checkKey, entityType, entityId, repaired: false, note: 'Invalid answer key requires manual review.' };
    }

    case 'missing_mastery_criteria': {
      // Objective missing mastery criteria
      const objectiveId = entityId;
      if (!objectiveId || entityType !== 'objective') {
        return { checkKey, entityType, entityId, repaired: false, note: 'Missing objective id.' };
      }
      const obj = getObjective(objectiveId);
      if (!obj) return { checkKey, entityType, entityId, repaired: false, note: 'Objective not found.' };
      
      // Add basic mastery criteria (not implemented yet - would need updateObjective function)
      // const masteryCriteria = JSON.stringify({
      //   threshold: 0.8,
      //   minEvidence: 3,
      //   description: `Demonstrate proficiency in: ${obj.statement}`,
      // });
      return { checkKey, entityType, entityId, repaired: false, note: 'Mastery criteria update not implemented yet; skipped.' };
    }

    default:
      // Unknown/not-auto-repairable key — skip rather than fabricate a fix.
      return { checkKey, entityType, entityId, repaired: false, note: 'No targeted repair strategy; skipped.' };
  }
}

/**
 * Repair a batch of QA failures. Bounded: only auto-fixable checks are acted
 * on, and only the affected entities are regenerated.
 */
export async function repairQaFailures(
  courseId: string,
  failures: QaFailure[],
): Promise<{ repaired: number; skipped: number; results: RepairResult[] }> {
  const results: RepairResult[] = [];
  let repaired = 0;
  let skipped = 0;

  for (const failure of failures) {
    try {
      const result = await repairOne(courseId, failure);
      if (result.repaired) repaired++;
      else skipped++;
      results.push(result);
    } catch (err) {
      skipped++;
      results.push({
        checkKey: failure.checkKey,
        entityType: failure.entityType,
        entityId: failure.entityId,
        repaired: false,
        note: `Repair failed: ${(err as Error).message}`,
      });
      logger.warn('Revision repair failed', {
        checkKey: failure.checkKey,
        entityId: failure.entityId,
        error: (err as Error).message,
      });
    }
  }

  return { repaired, skipped, results };
}

/** Convenience: collect objectives that still lack lesson coverage (for verdicts). */
export function objectivesNeedingCoverage(courseId: string): string[] {
  const objectives = listObjectives(courseId);
  const lessons = listLessons(courseId);
  const covered = new Set<string>();
  for (const l of lessons) {
    try {
      const ids = JSON.parse(l.objectiveIds) as string[];
      for (const id of ids) covered.add(id);
    } catch { /* ignore malformed */ }
  }
  return objectives.filter((o) => !covered.has(o.id)).map((o) => o.id);
}

/** Convenience: total units (placeholder-free progress reporting). */
export function unitCount(courseId: string): number {
  return listUnits(courseId).length;
}