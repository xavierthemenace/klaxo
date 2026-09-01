/**
 * CourseGenerationService — generate the full curriculum from a blueprint.
 *
 * Stages:
 *   1. Curriculum blueprint (planning model)
 *   2. Prerequisite/dependency analysis
 *   3. Units & objectives persisted
 *   4. Lessons (generation model)
 *   5. Practice (generation model)
 *   6. Assessments (assessment model)
 *
 * Each stage uses the model-router to select the right NIM model. Source
 * material is delimited; classification (REQUIRED/ENRICHMENT) is preserved.
 */
import { randomUUID } from 'node:crypto';
import { getAiContext } from '../ai';
import { generateStructured, resolveModel } from '../ai/router';
import {
  CurriculumBlueprint,
  CurriculumBlueprintSchema,
  LessonContent,
  LessonContentSchema,
  PracticeSet,
  PracticeSetSchema,
  Assessment,
  AssessmentSchema,
} from '../ai/types';
import {
  BLUEPRINT_SYSTEM,
  LESSON_SYSTEM,
  PRACTICE_SYSTEM,
  ASSESSMENT_SYSTEM,
  delimitSource,
} from '../pipeline/prompts';
import {
  getLatestKnowledgePackage,
  createUnit,
  createTopic,
  createObjective,
  createDependency,
  createLesson,
  createPracticeSet,
  createAssessment,
  createQuestion,
  createProvenance,
  getObjective,
  getSourceFragment,
  upsertBlueprint,
  getBlueprint,
} from '../db/repo';
import { pipelineFailed } from '../lib/errors';

/* ------------------------------------------------------------ blueprint ---- */

export async function generateBlueprint(courseId: string): Promise<CurriculumBlueprint> {
  const { provider, routing } = getAiContext();
  const kp = getLatestKnowledgePackage(courseId);
  if (!kp) throw pipelineFailed('No approved source interpretation found.');

  const source = JSON.parse(kp.payload);
  const model = resolveModel(routing, 'curriculum_planning');

  const messages = [
    { role: 'system' as const, content: BLUEPRINT_SYSTEM },
    {
      role: 'user' as const,
      content: `Accepted source interpretation:\n${delimitSource(JSON.stringify(source, null, 2))}`,
    },
  ];

  const result = await generateStructured(
    provider,
    model,
    { messages, schema: CurriculumBlueprintSchema },
    { maxRetries: 2, temperature: 0.3 },
  );

  return result.value;
}

/* ------------------------------------------------- prerequisite & units ---- */

/**
 * Persist the blueprint as normalized entities (units, topics, objectives,
 * dependencies) with provenance links back to the knowledge package.
 *
 * Creates provenance records with REAL database entity IDs and source fragment IDs
 * from the approved knowledge package.
 */
/** Loose key for matching an objective by its wording. */
function normaliseObjectiveKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.;:]+$/, '');
}

export async function persistBlueprint(courseId: string, blueprint: CurriculumBlueprint): Promise<void> {
  const kp = getLatestKnowledgePackage(courseId);

  const unitIdMap = new Map<number, string>();
  const objectiveIdMap = new Map<string, { dbId: string; ordinal: number }>();
  const objectiveFragmentMap = new Map<string, string[]>(); // statement -> fragmentIds
  const objectiveStatementMap = new Map<string, { dbId: string; ordinal: number }>();

  // Load fragment references from knowledge package if available.
  if (kp) {
    const kpPayload = JSON.parse(kp.payload);
    for (const obj of kpPayload.objectives ?? []) {
      const fragmentIds = obj.sourceFragmentIds ?? [];
      if (fragmentIds.length > 0 && fragmentIds[0] !== 'INFERRED_FROM_SOURCE_SET') {
        objectiveFragmentMap.set(obj.statement, fragmentIds);
      }
    }
  }

  // Units + topics.
  for (const [u, unit] of blueprint.units.entries()) {
    const unitId = `unit_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    unitIdMap.set(u, unitId);

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

    // Provenance for unit
    if (kp) {
      createProvenance({
        id: `prov_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
        courseId,
        entityType: 'unit',
        entityId: unitId,
        relation: 'DERIVED_FROM',
        note: `Unit from approved knowledge package: ${kp.id}`,
      });
    }

    for (const [t, topic] of unit.topics.entries()) {
      const topicId = `topic_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
      createTopic({
        id: topicId,
        courseId,
        unitId,
        ordinal: t,
        title: topic.title,
        description: topic.description,
        classification: topic.classification,
        origin: 'AI_GENERATED',
      });

      // Provenance for topic
      if (kp) {
        createProvenance({
          id: `prov_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
          courseId,
          entityType: 'topic',
          entityId: topicId,
          relation: 'DERIVED_FROM',
          note: `Topic from approved knowledge package: ${kp.id}`,
        });
      }
    }

    // Objectives.
    for (const [o, obj] of unit.objectives.entries()) {
      const objectiveId = `obj_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
      const code = obj.id ?? `U${u + 1}.O${o + 1}`;
      createObjective({
        id: objectiveId,
        courseId,
        unitId,
        ordinal: o,
        code,
        title: obj.statement.slice(0, 60),
        statement: obj.statement,
        category: obj.category,
        difficulty: obj.difficulty,
        importance: obj.importance,
        classification: obj.classification,
        origin: 'AI_GENERATED',
      });
      objectiveIdMap.set(code, { dbId: objectiveId, ordinal: o });
      // Models regularly cite an objective by its wording rather than its id,
      // even when asked for the id. Accept both, so an edge is not silently
      // dropped over a naming difference.
      objectiveStatementMap.set(normaliseObjectiveKey(obj.statement), {
        dbId: objectiveId,
        ordinal: o,
      });

      // Create provenance for objective with REAL database ID and fragment references
      if (kp) {
        // Get fragment IDs for this objective statement
        const fragmentIds = objectiveFragmentMap.get(obj.statement) ?? [];
        
        if (fragmentIds.length > 0) {
          // Create provenance linking to each source fragment
          for (const fragmentId of fragmentIds) {
            const frag = getSourceFragment(fragmentId);
            if (frag) {
              createProvenance({
                id: `prov_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
                courseId,
                entityType: 'objective',
                entityId: objectiveId,
                fragmentId: frag.id,
                documentId: frag.documentId,
                relation: 'DERIVED_FROM',
                confidence: kp.confidence ?? undefined,
                note: obj.statement,
              });
            }
          }
        } else {
          // No specific fragment — inferred from source set
          createProvenance({
            id: `prov_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
            courseId,
            entityType: 'objective',
            entityId: objectiveId,
            relation: 'INFERRED_FROM_SOURCE_SET',
            confidence: kp.confidence ?? undefined,
            note: obj.statement,
          });
        }
      }
    }
  }

  // Dependencies.
  const resolveObjectiveRef = (ref: string) =>
    objectiveIdMap.get(ref) ?? objectiveStatementMap.get(normaliseObjectiveKey(ref));

  for (const edge of blueprint.prerequisites) {
    const from = resolveObjectiveRef(edge.objectiveId);
    const to = resolveObjectiveRef(edge.prerequisiteId);
    if (from && to && from.dbId !== to.dbId) {
      createDependency({
        id: `dep_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
        courseId,
        objectiveId: from.dbId,
        prerequisiteId: to.dbId,
        strength: edge.strength,
        rationale: edge.rationale,
      });
    }
  }

  // Persist the canonical blueprint snapshot. This is the authoritative recovery
  // source — generation never reconstructs an approximation from entities.
  upsertBlueprint({
    id: `bp_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    courseId,
    payload: JSON.stringify(blueprint),
    knowledgePackageId: kp?.id ?? undefined,
    status: 'approved',
  });
}

/**
 * Load the canonical persisted blueprint. Returns null only if never persisted.
 * Generation should use this instead of reconstructing from entities.
 */
export function loadPersistedBlueprint(courseId: string): CurriculumBlueprint | null {
  const record = getBlueprint(courseId);
  if (!record) return null;
  try {
    return JSON.parse(record.payload) as CurriculumBlueprint;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- lesson ---- */

export async function generateLesson(
  courseId: string,
  unitId: string,
  objectiveIds: string[],
  topicId?: string,
  _ordinal = 0,
): Promise<LessonContent> {
  const { provider, routing } = getAiContext();
  const model = resolveModel(routing, 'lesson_generation');

  const objectiveStmts = objectiveIds
    .map((id) => getObjectiveStatement(id))
    .filter(Boolean);

  const messages = [
    { role: 'system' as const, content: LESSON_SYSTEM },
    {
      role: 'user' as const,
      content: `Generate a lesson aligned to these learning objectives:\n${objectiveStmts.join('\n')}`,
    },
  ];

  const result = await generateStructured(
    provider,
    model,
    { messages, schema: LessonContentSchema },
    { maxRetries: 2, temperature: 0.4 },
  );

  return result.value;
}

function getObjectiveStatement(objectiveId: string): string {
  const obj = getObjective(objectiveId);
  return obj?.statement ?? objectiveId;
}

/* ------------------------------------------------------- practice & assess ---- */

export async function generatePractice(
  courseId: string,
  objectiveId: string,
): Promise<PracticeSet> {
  const { provider, routing } = getAiContext();
  const model = resolveModel(routing, 'practice_generation');

  const messages = [
    { role: 'system' as const, content: PRACTICE_SYSTEM },
    {
      role: 'user' as const,
      content: `Generate progressive practice for this objective:\n${getObjectiveStatement(objectiveId)}`,
    },
  ];

  const result = await generateStructured(
    provider,
    model,
    { messages, schema: PracticeSetSchema },
    { maxRetries: 2, temperature: 0.4 },
  );

  return result.value;
}

export async function generateAssessment(
  courseId: string,
  objectiveIds: string[],
  kind: string = 'unit',
): Promise<Assessment> {
  const { provider, routing } = getAiContext();
  const model = resolveModel(routing, 'assessment_generation');

  const statements = objectiveIds.map((id) => getObjectiveStatement(id)).filter(Boolean);

  const messages = [
    { role: 'system' as const, content: ASSESSMENT_SYSTEM },
    {
      role: 'user' as const,
      content: `Generate a ${kind} assessment for these objectives:\n${statements.join('\n')}`,
    },
  ];

  const result = await generateStructured(
    provider,
    model,
    { messages, schema: AssessmentSchema },
    { maxRetries: 2, temperature: 0.2 },
  );

  return result.value;
}

/* ----------------------------------------------------------- persistence ---- */

export function persistLesson(
  courseId: string,
  unitId: string,
  topicId: string | undefined,
  ordinal: number,
  objectiveIds: string[],
  content: LessonContent,
) {
  // Determine classification from objectives (most severe wins: ENRICHMENT > RECOMMENDED > PREREQUISITE > REQUIRED)
  let classification = 'REQUIRED';
  if (objectiveIds.length > 0) {
    const classifications = objectiveIds
      .map((id) => getObjective(id)?.classification)
      .filter((c): c is string => Boolean(c));
    if (classifications.includes('ENRICHMENT')) classification = 'ENRICHMENT';
    else if (classifications.includes('RECOMMENDED')) classification = 'RECOMMENDED';
    else if (classifications.includes('PREREQUISITE')) classification = 'PREREQUISITE';
    else classification = 'REQUIRED';
  }

  const lesson = createLesson({
    id: `les_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    courseId,
    unitId,
    topicId,
    ordinal,
    title: content.sections[0]?.title ?? 'Lesson',
    summary: content.summary,
    objectiveIds: JSON.stringify(objectiveIds),
    content: JSON.stringify(content),
    estimatedMinutes: content.estimatedMinutes,
    classification,
    status: 'generated',
    origin: 'AI_GENERATED',
  });

  // Create provenance linking lesson to its objectives
  for (const objId of objectiveIds) {
    createProvenance({
      id: `prov_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      courseId,
      entityType: 'lesson',
      entityId: lesson.id,
      relation: 'DERIVED_FROM',
      note: `Lesson covering objective ${objId}`,
    });
  }

  return lesson;
}

export function persistPracticeSet(
  courseId: string,
  objectiveId: string | undefined,
  lessonId: string | undefined,
  set: PracticeSet,
) {
  const ps = createPracticeSet({
    id: `ps_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    courseId,
    objectiveId,
    lessonId,
    title: set.title,
    level: set.level,
    origin: 'AI_GENERATED',
  });

  // Create provenance linking practice set to its objective
  if (objectiveId) {
    createProvenance({
      id: `prov_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      courseId,
      entityType: 'practice_set',
      entityId: ps.id,
      relation: 'DERIVED_FROM',
      note: `Practice set for objective ${objectiveId}`,
    });
  }

  let ordinal = 0;
  for (const q of set.questions) {
    const questionOrdinal = ordinal++;
    const question = createQuestion({
      id: `q_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      courseId,
      objectiveId,
      practiceSetId: ps.id,
      ordinal: questionOrdinal,
      kind: q.kind,
      level: q.level,
      prompt: q.prompt,
      choices: q.choices ? JSON.stringify(q.choices) : undefined,
      answerKey: q.answerKey ? JSON.stringify(q.answerKey) : undefined,
      explanation: q.explanation,
      misconceptions: q.misconceptions?.length ? JSON.stringify(q.misconceptions) : undefined,
      expectedSkill: q.expectedSkill,
      difficulty: q.difficulty,
      origin: 'AI_GENERATED',
    });

    // Create provenance linking question to its objective
    if (objectiveId) {
      createProvenance({
        id: `prov_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
        courseId,
        entityType: 'question',
        entityId: question.id,
        relation: 'DERIVED_FROM',
        note: `Practice question for objective ${objectiveId}`,
      });
    }
  }
}

export function persistAssessment(
  courseId: string,
  unitId: string | undefined,
  assessment: Assessment,
  /**
   * The real objective ids the assessment was generated for. The model's own
   * `objectiveIds` are free text, so these are what actually get stored — every
   * question needs one or answering it is rejected as invalid input.
   */
  objectiveIds: string[] = [],
) {
  const linkedObjectiveIds = objectiveIds.length > 0 ? objectiveIds : assessment.objectiveIds;

  const asm = createAssessment({
    id: `asm_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    courseId,
    unitId,
    kind: assessment.kind,
    title: assessment.title,
    instructions: assessment.instructions,
    objectiveIds: JSON.stringify(linkedObjectiveIds),
    passThreshold: assessment.passThreshold,
    origin: 'AI_GENERATED',
  });

  // Create provenance linking assessment to its objectives
  for (const objId of linkedObjectiveIds) {
    createProvenance({
      id: `prov_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      courseId,
      entityType: 'assessment',
      entityId: asm.id,
      relation: 'DERIVED_FROM',
      note: `Assessment covering objective ${objId}`,
    });
  }

  let ordinal = 0;
  for (const q of assessment.questions) {
    // Spread the questions across the objectives being assessed. Something has
    // to be set here: the answer-submission API requires an objective id, and
    // mastery is tracked per objective.
    const questionObjectiveId = linkedObjectiveIds.length > 0
      ? linkedObjectiveIds[ordinal % linkedObjectiveIds.length]
      : undefined;

    const question = createQuestion({
      id: `q_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      courseId,
      assessmentId: asm.id,
      objectiveId: questionObjectiveId,
      ordinal: ordinal++,
      kind: q.kind,
      level: 'independent',
      prompt: q.prompt,
      choices: q.choices ? JSON.stringify(q.choices) : undefined,
      answerKey: q.answerKey ? JSON.stringify(q.answerKey) : undefined,
      explanation: q.explanation,
      misconceptions: q.misconceptions?.length ? JSON.stringify(q.misconceptions) : undefined,
      expectedSkill: q.expectedSkill,
      difficulty: q.difficulty,
      origin: 'AI_GENERATED',
    });

    // Create provenance linking question to its objectives
    for (const objId of linkedObjectiveIds) {
      createProvenance({
        id: `prov_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
        courseId,
        entityType: 'question',
        entityId: question.id,
        relation: 'DERIVED_FROM',
        note: `Assessment question for objective ${objId}`,
      });
    }
  }
}