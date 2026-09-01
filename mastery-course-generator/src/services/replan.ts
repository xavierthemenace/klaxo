/**
 * Re-planning: fold new material into a course that already exists.
 *
 * The first build is a straight line — material, interpretation, plan,
 * generate. Adding material afterwards is a different problem: there is
 * already a plan on screen, and there is already progress recorded against it.
 * Rebuilding from scratch would throw both away, and running the blueprint
 * again would insert a second set of units beside the first.
 *
 * So a replan is a *merge*, and it turns on one idea: an objective is
 * identified by what it says. If the new plan contains an objective whose
 * statement matches one already in the course, that is the same objective —
 * it keeps its row, which means it keeps its id, which means every practice
 * attempt and mastery record attached to it survives untouched. Objectives
 * that only appear in the new plan are added. Objectives that have vanished
 * are removed along with the lessons and questions written for them.
 *
 * The caller snapshots the course as a version first, so an unwelcome replan
 * is one restore away.
 */
import {
  createDependency,
  createObjective,
  createTopic,
  createUnit,
  deleteDependenciesForObjective,
  deleteLesson,
  deleteProvenanceForEntity,
  deleteObjective,
  deletePracticeSetsByObjective,
  deleteQuestionsByObjective,
  deleteTopic,
  deleteUnit,
  detachAssessmentsFromUnits,
  getCourse,
  listLessons,
  listObjectives,
  listTopics,
  listUnits,
  updateLesson,
  updateObjective,
  upsertBlueprint,
  getLatestKnowledgePackage,
  deleteDependenciesByCourse,
} from '@/db/repo';
import { getDb } from '@/db/index';
import { newId } from '@/lib/ids';
import { logger } from '@/lib/logger';
import { notFound } from '@/lib/errors';
import type { CurriculumBlueprint } from '@/ai/types';
import { generateBlueprint } from './course-generation';

export interface ReplanSummary {
  kept: number;
  added: number;
  removed: number;
  /** Objectives with no lesson or practice yet — what generation must fill in. */
  addedObjectiveIds: string[];
  removedStatements: string[];
}

/**
 * Two statements are the same objective if they say the same thing. Casing,
 * spacing and a trailing full stop are not differences worth losing a
 * student's progress over.
 */
export function objectiveKey(statement: string): string {
  return statement
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.\s]+$/, '')
    .trim();
}

/**
 * Merge a freshly generated blueprint into the course that is already there.
 *
 * One transaction: a half-applied plan is worse than no replan at all.
 */
export function mergeBlueprint(courseId: string, blueprint: CurriculumBlueprint): ReplanSummary {
  const course = getCourse(courseId);
  if (!course) throw notFound('Course not found');

  const existingObjectives = listObjectives(courseId);
  const existingByKey = new Map(existingObjectives.map((o) => [objectiveKey(o.statement), o]));
  const seenKeys = new Set<string>();

  const summary: ReplanSummary = {
    kept: 0,
    added: 0,
    removed: 0,
    addedObjectiveIds: [],
    removedStatements: [],
  };

  getDb().transaction(() => {
    const oldUnits = listUnits(courseId);
    const oldTopics = listTopics(courseId);
    // objective id -> the new unit it now belongs to, so surviving lessons can
    // follow their objective across.
    const newUnitByObjective = new Map<string, string>();
    // Objective code (and wording) -> database id, so the new plan's
    // prerequisite edges can be rebuilt below.
    const objectiveRefToId = new Map<string, string>();

    // Units and topics are cheap structure with nothing hanging off them, so
    // they are rebuilt outright. Objectives are the opposite, which is exactly
    // why they are matched rather than replaced.
    for (const [u, unit] of (blueprint.units ?? []).entries()) {
      const unitId = newId('unt');
      createUnit({
        id: unitId,
        courseId,
        ordinal: u,
        title: unit.title,
        description: unit.description,
        classification: unit.classification,
        estimatedMinutes: unit.estimatedMinutes,
        origin: 'AI_GENERATED',
      });

      for (const [t, topic] of (unit.topics ?? []).entries()) {
        createTopic({
          id: newId('top'),
          courseId,
          unitId,
          ordinal: t,
          title: topic.title,
          description: topic.description,
          classification: topic.classification,
          origin: 'AI_GENERATED',
        });
      }

      for (const [o, objective] of (unit.objectives ?? []).entries()) {
        const key = objectiveKey(objective.statement);
        seenKeys.add(key);
        const existing = existingByKey.get(key);
        const code = objective.id ?? `U${u + 1}.O${o + 1}`;

        if (existing) {
          // Same objective, new home. Keeping the row keeps the mastery.
          updateObjective(existing.id, {
            unitId,
            topicId: null,
            ordinal: o,
            code,
            statement: objective.statement,
            category: objective.category,
            difficulty: objective.difficulty,
            importance: objective.importance,
            classification: objective.classification,
          });
          newUnitByObjective.set(existing.id, unitId);
          objectiveRefToId.set(code, existing.id);
          objectiveRefToId.set(key, existing.id);
          summary.kept++;
        } else {
          const objectiveId = newId('obj');
          createObjective({
            id: objectiveId,
            courseId,
            unitId,
            ordinal: o,
            code,
            title: objective.statement.slice(0, 60),
            statement: objective.statement,
            category: objective.category,
            difficulty: objective.difficulty,
            importance: objective.importance,
            classification: objective.classification,
            origin: 'AI_GENERATED',
          });
          newUnitByObjective.set(objectiveId, unitId);
          objectiveRefToId.set(code, objectiveId);
          objectiveRefToId.set(key, objectiveId);
          summary.added++;
          summary.addedObjectiveIds.push(objectiveId);
        }
      }
    }

    // Anything the new plan no longer mentions goes, along with the material
    // written for it — a lesson for an objective that no longer exists is
    // just debris.
    const lessons = listLessons(courseId);
    for (const [key, objective] of existingByKey) {
      if (seenKeys.has(key)) continue;

      deleteQuestionsByObjective(objective.id);
      deletePracticeSetsByObjective(objective.id);
      deleteDependenciesForObjective(objective.id);

      for (const lesson of lessons) {
        let ids: string[] = [];
        try {
          ids = JSON.parse(lesson.objectiveIds ?? '[]') as string[];
        } catch {
          ids = [];
        }
        // Only drop a lesson that existed solely for this objective.
        if (ids.length > 0 && ids.every((id) => id === objective.id)) {
          deleteLesson(lesson.id);
        }
      }

      deleteObjective(objective.id);
      summary.removed++;
      summary.removedStatements.push(objective.statement);
    }

    // A lesson written for an objective that survived is still valid, so it
    // moves across with it. Without this the old units cannot be deleted at
    // all: a lesson's unit is a required foreign key.
    for (const lesson of listLessons(courseId)) {
      let ids: string[] = [];
      try {
        ids = JSON.parse(lesson.objectiveIds ?? '[]') as string[];
      } catch {
        ids = [];
      }
      const newUnitId = ids.map((id) => newUnitByObjective.get(id)).find(Boolean);
      if (newUnitId) {
        updateLesson(lesson.id, { unitId: newUnitId, topicId: null });
      } else {
        // Orphaned: every objective it was written for is gone.
        deleteLesson(lesson.id);
      }
    }

    // Assessments point at a unit too. They span the whole course, so they
    // are detached rather than thrown away.
    detachAssessmentsFromUnits(courseId);

    // The old units and topics are empty shells now. Their provenance rows
    // reference them, so those go first.
    // By id, not by course: the new units and topics were created above in
    // this same transaction, and a by-course delete would take them too.
    for (const topic of oldTopics) {
      deleteProvenanceForEntity('topic', topic.id);
      deleteTopic(topic.id);
    }
    for (const unit of oldUnits) {
      deleteProvenanceForEntity('unit', unit.id);
      deleteUnit(unit.id);
    }

    // Rebuild the prerequisite graph from the new plan. Without this a replan
    // left the course with whatever edges happened to survive.
    deleteDependenciesByCourse(courseId);
    for (const edge of blueprint.prerequisites ?? []) {
      const from = objectiveRefToId.get(edge.objectiveId)
        ?? objectiveRefToId.get(objectiveKey(edge.objectiveId));
      const to = objectiveRefToId.get(edge.prerequisiteId)
        ?? objectiveRefToId.get(objectiveKey(edge.prerequisiteId));
      if (from && to && from !== to) {
        createDependency({
          id: newId('dep'),
          courseId,
          objectiveId: from,
          prerequisiteId: to,
          strength: edge.strength,
          rationale: edge.rationale,
        });
      }
    }

    // The canonical snapshot has to move too. `loadPersistedBlueprint` reads
    // it on every later build, so leaving the old one meant a replanned course
    // was generated from the plan it had just replaced.
    upsertBlueprint({
      id: newId('bp'),
      courseId,
      payload: JSON.stringify(blueprint),
      knowledgePackageId: getLatestKnowledgePackage(courseId)?.id ?? undefined,
      status: 'approved',
    });
  });

  logger.info('replan merged', {
    courseId,
    kept: summary.kept,
    added: summary.added,
    removed: summary.removed,
  });

  return summary;
}

/**
 * Re-plan a course from the current interpretation of its material.
 *
 * Any new sources must have been analysed first — this reads whatever the
 * latest knowledge package says.
 */
export async function replanCourse(courseId: string): Promise<ReplanSummary> {
  const blueprint = await generateBlueprint(courseId);
  return mergeBlueprint(courseId, blueprint);
}
