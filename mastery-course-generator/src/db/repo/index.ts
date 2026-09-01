/**
 * Repository layer — data access for all entities.
 *
 * This module wraps Drizzle queries so route handlers and services never touch
 * Drizzle directly. Ownership checks (`userId`) are applied at the call site;
 * these helpers provide typed, predictable CRUD.
 */
import { eq, desc, asc, and, or, inArray, lt } from 'drizzle-orm';
import { getDb, schema } from '../index';

const {
  users,
  courses,
  courseVersions,
  sourceDocuments,
  sourceFragments,
  knowledgePackages,
  blueprints,
  units,
  topics,
  objectives,
  objectiveDependencies,
  lessons,
  activities,
  practiceSets,
  assessments,
  questions,
  masteryRecords,
  questionAttempts,
  provenance,
  qaResults,
  generationJobs,
  generationEvents,
  userEdits,
  courseShares,
  courseEnrollments,
} = schema;


/* ------------------------------------------------------------ users ---- */

export function getUserByEmail(email: string) {
  return getDb().select().from(users).where(eq(users.email, email)).get();
}

export function createUser(input: {
  id: string;
  email: string;
  displayName?: string;
  passwordHash?: string;
  role?: string;
}) {
  return getDb()
    .insert(users)
    .values({
      id: input.id,
      email: input.email,
      displayName: input.displayName ?? null,
      passwordHash: input.passwordHash ?? null,
      role: input.role ?? 'teacher',
    })
    .returning()
    .get();
}

export function getUserById(id: string) {
  return getDb().select().from(users).where(eq(users.id, id)).get();
}

export function updateUserAccount(
  id: string,
  data: Partial<{ email: string; displayName: string; passwordHash: string; role: string }>,
) {
  return getDb().update(users).set(data).where(eq(users.id, id)).returning().get();
}

/* ------------------------------------------------------------ sharing ---- */

export function createCourseShare(input: { id: string; courseId: string; token: string }) {
  return getDb()
    .insert(courseShares)
    .values({ id: input.id, courseId: input.courseId, token: input.token })
    .returning()
    .get();
}

export function getActiveShareForCourse(courseId: string) {
  return getDb()
    .select()
    .from(courseShares)
    .where(eq(courseShares.courseId, courseId))
    .orderBy(desc(courseShares.createdAt))
    .all()
    .find((s) => s.revokedAt == null);
}

export function getShareByToken(token: string) {
  return getDb().select().from(courseShares).where(eq(courseShares.token, token)).get();
}

export function revokeShare(id: string) {
  return getDb()
    .update(courseShares)
    .set({ revokedAt: Date.now() })
    .where(eq(courseShares.id, id))
    .returning()
    .get();
}

export function createEnrollment(input: {
  id: string;
  courseId: string;
  userId: string;
  shareId: string;
}) {
  return getDb().insert(courseEnrollments).values(input).returning().get();
}

export function getEnrollment(courseId: string, userId: string) {
  return getDb()
    .select()
    .from(courseEnrollments)
    .where(and(eq(courseEnrollments.courseId, courseId), eq(courseEnrollments.userId, userId)))
    .get();
}

/** Learners enrolled in a course, with their display names. */
export function listEnrollments(courseId: string) {
  return getDb()
    .select({
      id: courseEnrollments.id,
      userId: courseEnrollments.userId,
      joinedAt: courseEnrollments.joinedAt,
      displayName: users.displayName,
    })
    .from(courseEnrollments)
    .innerJoin(users, eq(users.id, courseEnrollments.userId))
    .where(eq(courseEnrollments.courseId, courseId))
    .orderBy(asc(courseEnrollments.joinedAt))
    .all();
}

/* ------------------------------------------------------------ courses ---- */

export function createCourse(input: {
  id: string;
  userId: string;
  title: string;
  description?: string;
  subjectDomain?: string;
  targetLevel?: string;
  preferences?: string;
}) {
  return getDb()
    .insert(courses)
    .values({
      id: input.id,
      userId: input.userId,
      title: input.title,
      description: input.description ?? null,
      subjectDomain: input.subjectDomain ?? null,
      targetLevel: input.targetLevel ?? null,
      preferences: input.preferences ?? null,
      status: 'draft',
      stage: 'CREATED',
    })
    .returning()
    .get();
}

export function getCourse(id: string) {
  return getDb().select().from(courses).where(eq(courses.id, id)).get();
}

/**
 * Delete a course and everything hanging off it.
 *
 * The foreign keys are declared without ON DELETE CASCADE, and existing
 * databases were created from that DDL, so SQLite refuses to drop a course that
 * has any material at all. Rather than rewrite every table on upgrade, the
 * children are removed here in reverse-dependency order inside one transaction.
 */
export function deleteCourseCascade(courseId: string): void {
  const db = getDb();

  // Leaves first, roots last: anything that references another row in this list
  // must be deleted before the row it points at.
  const orderedTables = [
    questionAttempts,
    masteryRecords,
    provenance,
    questions,
    assessments,
    practiceSets,
    activities,
    lessons,
    objectiveDependencies,
    objectives,
    topics,
    units,
    blueprints,
    knowledgePackages,
    sourceFragments,
    sourceDocuments,
    qaResults,
    generationEvents,
    generationJobs,
    userEdits,
    courseEnrollments,
    courseShares,
    courseVersions,
  ];

  db.transaction((tx) => {
    for (const table of orderedTables) {
      tx.delete(table).where(eq(table.courseId, courseId)).run();
    }
    tx.delete(courses).where(eq(courses.id, courseId)).run();
  });
}

export function listCoursesForUser(userId: string) {
  return getDb()
    .select()
    .from(courses)
    .where(eq(courses.userId, userId))
    .orderBy(desc(courses.updatedAt))
    .all();
}

export function updateCourse(id: string, data: Partial<{
  title: string;
  description: string;
  subjectDomain: string;
  targetLevel: string;
  status: string;
  stage: string;
  preferences: string;
  currentVersionId: string;
}>) {
  return getDb()
    .update(courses)
    .set({ ...data, updatedAt: Date.now() })
    .where(eq(courses.id, id))
    .returning()
    .get();
}

/* ------------------------------------------------------ courseVersions ---- */

export function createCourseVersion(input: {
  id: string;
  courseId: string;
  versionNumber: number;
  label?: string;
  snapshot?: string;
  notes?: string;
}) {
  return getDb()
    .insert(courseVersions)
    .values({
      id: input.id,
      courseId: input.courseId,
      versionNumber: input.versionNumber,
      label: input.label ?? null,
      snapshot: input.snapshot ?? null,
      notes: input.notes ?? null,
      status: 'draft',
    })
    .returning()
    .get();
}

export function getCourseVersion(id: string) {
  return getDb().select().from(courseVersions).where(eq(courseVersions.id, id)).get();
}

export function listCourseVersions(courseId: string) {
  return getDb()
    .select()
    .from(courseVersions)
    .where(eq(courseVersions.courseId, courseId))
    .orderBy(desc(courseVersions.versionNumber))
    .all();
}

export function getLatestCourseVersion(courseId: string) {
  return getDb()
    .select()
    .from(courseVersions)
    .where(eq(courseVersions.courseId, courseId))
    .orderBy(desc(courseVersions.versionNumber))
    .limit(1)
    .get();
}

/* ------------------------------------------------------ sourceDocuments ---- */

export function createSourceDocument(input: {
  id: string;
  courseId: string;
  kind: string;
  filename?: string;
  mimeType?: string;
  byteSize?: number;
  storagePath?: string;
  checksum?: string;
  extractedText?: string;
  pageCount?: number;
  status?: string;
}) {
  return getDb()
    .insert(sourceDocuments)
    .values({
      id: input.id,
      courseId: input.courseId,
      kind: input.kind,
      filename: input.filename ?? null,
      mimeType: input.mimeType ?? null,
      byteSize: input.byteSize ?? null,
      storagePath: input.storagePath ?? null,
      checksum: input.checksum ?? null,
      extractedText: input.extractedText ?? null,
      pageCount: input.pageCount ?? null,
      status: input.status ?? 'uploaded',
    })
    .returning()
    .get();
}

export function getSourceDocument(id: string) {
  return getDb().select().from(sourceDocuments).where(eq(sourceDocuments.id, id)).get();
}

export function listSourceDocuments(courseId: string) {
  return getDb()
    .select()
    .from(sourceDocuments)
    .where(eq(sourceDocuments.courseId, courseId))
    .orderBy(asc(sourceDocuments.createdAt))
    .all();
}

export function updateSourceDocument(id: string, data: Partial<{
  extractedText: string;
  pageCount: number;
  status: string;
  error: string;
  extractionModel: string;
  extractionProvider: string;
  confidence: number;
}>) {
  return getDb()
    .update(sourceDocuments)
    .set(data)
    .where(eq(sourceDocuments.id, id))
    .returning()
    .get();
}

/* ------------------------------------------------------ sourceFragments ---- */

export function createSourceFragment(input: {
  id: string;
  courseId: string;
  documentId: string;
  ordinal: number;
  kind: string;
  text: string;
  page?: number;
  confidence?: number;
  uncertain?: number;
}) {
  return getDb()
    .insert(sourceFragments)
    .values({
      id: input.id,
      courseId: input.courseId,
      documentId: input.documentId,
      ordinal: input.ordinal,
      kind: input.kind,
      text: input.text,
      page: input.page ?? null,
      confidence: input.confidence ?? null,
      uncertain: input.uncertain ?? 0,
    })
    .returning()
    .get();
}

export function listSourceFragments(courseId: string) {
  return getDb()
    .select()
    .from(sourceFragments)
    .where(eq(sourceFragments.courseId, courseId))
    .orderBy(asc(sourceFragments.ordinal))
    .all();
}

export function listSourceFragmentsForDocument(documentId: string) {
  return getDb()
    .select()
    .from(sourceFragments)
    .where(eq(sourceFragments.documentId, documentId))
    .orderBy(asc(sourceFragments.ordinal))
    .all();
}

export function getSourceFragment(id: string) {
  return getDb().select().from(sourceFragments).where(eq(sourceFragments.id, id)).get();
}

/* ---------------------------------------------------- knowledgePackages ---- */

export function createKnowledgePackage(input: {
  id: string;
  courseId: string;
  detectedTitle?: string;
  detectedSubject?: string;
  detectedLevel?: string;
  summary?: string;
  payload: string;
  confidence?: number;
  status?: string;
  origin?: string;
}) {
  return getDb()
    .insert(knowledgePackages)
    .values({
      id: input.id,
      courseId: input.courseId,
      detectedTitle: input.detectedTitle ?? null,
      detectedSubject: input.detectedSubject ?? null,
      detectedLevel: input.detectedLevel ?? null,
      summary: input.summary ?? null,
      payload: input.payload,
      confidence: input.confidence ?? null,
      status: input.status ?? 'draft',
      origin: input.origin ?? 'AI_GENERATED',
    })
    .returning()
    .get();
}

export function getKnowledgePackage(id: string) {
  return getDb().select().from(knowledgePackages).where(eq(knowledgePackages.id, id)).get();
}

export function getLatestKnowledgePackage(courseId: string) {
  return getDb()
    .select()
    .from(knowledgePackages)
    .where(eq(knowledgePackages.courseId, courseId))
    .orderBy(desc(knowledgePackages.version))
    .limit(1)
    .get();
}

export function updateKnowledgePackage(id: string, data: Partial<{
  payload: string;
  confidence: number;
  status: string;
  origin: string;
  approvedAt: number;
  detectedTitle: string;
  detectedSubject: string;
  detectedLevel: string;
  summary: string;
}>) {
  return getDb()
    .update(knowledgePackages)
    .set({ ...data, updatedAt: Date.now() })
    .where(eq(knowledgePackages.id, id))
    .returning()
    .get();
}

/* ----------------------------------------------------------- blueprints ---- */

export function upsertBlueprint(input: {
  id: string;
  courseId: string;
  payload: string;
  knowledgePackageId?: string;
  status?: string;
}) {
  const existing = getDb()
    .select()
    .from(blueprints)
    .where(eq(blueprints.courseId, input.courseId))
    .get();
  if (existing) {
    return getDb()
      .update(blueprints)
      .set({
        payload: input.payload,
        knowledgePackageId: input.knowledgePackageId ?? existing.knowledgePackageId,
        status: input.status ?? existing.status,
        updatedAt: Date.now(),
      })
      .where(eq(blueprints.id, existing.id))
      .returning()
      .get();
  }
  return getDb()
    .insert(blueprints)
    .values({
      id: input.id,
      courseId: input.courseId,
      payload: input.payload,
      knowledgePackageId: input.knowledgePackageId ?? null,
      status: input.status ?? 'draft',
    })
    .returning()
    .get();
}

export function getBlueprint(courseId: string) {
  return getDb()
    .select()
    .from(blueprints)
    .where(eq(blueprints.courseId, courseId))
    .get();
}

export function deleteBlueprintByCourse(courseId: string) {
  return getDb().delete(blueprints).where(eq(blueprints.courseId, courseId)).run();
}

/* --------------------------------------------------------------- units ---- */

export function createUnit(input: {
  id: string;
  courseId: string;
  ordinal: number;
  title: string;
  description?: string;
  classification?: string;
  estimatedMinutes?: number;
  origin?: string;
}) {
  return getDb()
    .insert(units)
    .values({
      id: input.id,
      courseId: input.courseId,
      ordinal: input.ordinal,
      title: input.title,
      description: input.description ?? null,
      classification: input.classification ?? 'REQUIRED',
      estimatedMinutes: input.estimatedMinutes ?? null,
      origin: input.origin ?? 'AI_GENERATED',
    })
    .returning()
    .get();
}

export function getUnit(id: string) {
  return getDb().select().from(units).where(eq(units.id, id)).get();
}

export function listUnits(courseId: string) {
  return getDb()
    .select()
    .from(units)
    .where(eq(units.courseId, courseId))
    .orderBy(asc(units.ordinal))
    .all();
}

export function updateUnit(id: string, data: Partial<{
  ordinal: number;
  title: string;
  description: string;
  classification: string;
  estimatedMinutes: number;
  origin: string;
}>) {
  return getDb()
    .update(units)
    .set({ ...data, updatedAt: Date.now() })
    .where(eq(units.id, id))
    .returning()
    .get();
}

export function deleteUnit(id: string) {
  return getDb().delete(units).where(eq(units.id, id)).run();
}

export function deleteUnitsByCourse(courseId: string) {
  return getDb().delete(units).where(eq(units.courseId, courseId)).run();
}

/* -------------------------------------------------------------- topics ---- */

export function createTopic(input: {
  id: string;
  courseId: string;
  unitId: string;
  ordinal: number;
  title: string;
  description?: string;
  classification?: string;
  origin?: string;
}) {
  return getDb()
    .insert(topics)
    .values({
      id: input.id,
      courseId: input.courseId,
      unitId: input.unitId,
      ordinal: input.ordinal,
      title: input.title,
      description: input.description ?? null,
      classification: input.classification ?? 'REQUIRED',
      origin: input.origin ?? 'AI_GENERATED',
    })
    .returning()
    .get();
}

export function listTopicsForUnit(unitId: string) {
  return getDb()
    .select()
    .from(topics)
    .where(eq(topics.unitId, unitId))
    .orderBy(asc(topics.ordinal))
    .all();
}

export function listTopics(courseId: string) {
  return getDb()
    .select()
    .from(topics)
    .where(eq(topics.courseId, courseId))
    .orderBy(asc(topics.ordinal))
    .all();
}

export function deleteTopic(id: string) {
  return getDb().delete(topics).where(eq(topics.id, id)).run();
}

export function deleteTopicsByCourse(courseId: string) {
  return getDb().delete(topics).where(eq(topics.courseId, courseId)).run();
}

/* ---------------------------------------------------------- objectives ---- */

export function createObjective(input: {
  id: string;
  courseId: string;
  unitId?: string;
  topicId?: string;
  ordinal: number;
  code?: string;
  title: string;
  statement: string;
  category?: string;
  bloom?: string;
  difficulty?: number;
  importance?: number;
  classification?: string;
  masteryCriteria?: string;
  origin?: string;
}) {
  return getDb()
    .insert(objectives)
    .values({
      id: input.id,
      courseId: input.courseId,
      unitId: input.unitId ?? null,
      topicId: input.topicId ?? null,
      ordinal: input.ordinal,
      code: input.code ?? null,
      title: input.title,
      statement: input.statement,
      category: input.category ?? 'skill',
      bloom: input.bloom ?? null,
      difficulty: input.difficulty ?? 3,
      importance: input.importance ?? 3,
      classification: input.classification ?? 'REQUIRED',
      masteryCriteria: input.masteryCriteria ?? null,
      origin: input.origin ?? 'AI_GENERATED',
    })
    .returning()
    .get();
}

export function getObjective(id: string) {
  return getDb().select().from(objectives).where(eq(objectives.id, id)).get();
}

export function listObjectives(courseId: string) {
  return getDb()
    .select()
    .from(objectives)
    .where(eq(objectives.courseId, courseId))
    .orderBy(asc(objectives.ordinal))
    .all();
}

export function listObjectivesForUnit(unitId: string) {
  return getDb()
    .select()
    .from(objectives)
    .where(eq(objectives.unitId, unitId))
    .orderBy(asc(objectives.ordinal))
    .all();
}

export function deleteObjectivesByCourse(courseId: string) {
  return getDb().delete(objectives).where(eq(objectives.courseId, courseId)).run();
}

export function updateObjective(id: string, data: Partial<{
  unitId: string | null;
  topicId: string | null;
  ordinal: number;
  code: string;
  title: string;
  statement: string;
  category: string;
  bloom: string;
  difficulty: number;
  importance: number;
  classification: string;
  masteryCriteria: string;
  origin: string;
}>) {
  return getDb()
    .update(objectives)
    .set({ ...data, updatedAt: Date.now() })
    .where(eq(objectives.id, id))
    .returning()
    .get();
}

/**
 * Targeted deletes, used when a replan drops an objective. The by-course
 * variants above are for wholesale rebuilds; these remove one objective and
 * everything hanging off it without touching the rest of the course.
 */
export function deleteObjective(id: string) {
  return getDb().delete(objectives).where(eq(objectives.id, id)).run();
}

export function deleteQuestionsByObjective(objectiveId: string) {
  return getDb().delete(questions).where(eq(questions.objectiveId, objectiveId)).run();
}

export function deletePracticeSetsByObjective(objectiveId: string) {
  return getDb().delete(practiceSets).where(eq(practiceSets.objectiveId, objectiveId)).run();
}

export function deleteDependenciesForObjective(objectiveId: string) {
  return getDb()
    .delete(objectiveDependencies)
    .where(
      or(
        eq(objectiveDependencies.objectiveId, objectiveId),
        eq(objectiveDependencies.prerequisiteId, objectiveId),
      ),
    )
    .run();
}

export function deleteLesson(id: string) {
  return getDb().delete(lessons).where(eq(lessons.id, id)).run();
}

export function deleteMasteryByObjective(objectiveId: string) {
  return getDb().delete(masteryRecords).where(eq(masteryRecords.objectiveId, objectiveId)).run();
}

/* ------------------------------------------------ objectiveDependencies ---- */

export function createDependency(input: {
  id: string;
  courseId: string;
  objectiveId: string;
  prerequisiteId: string;
  strength?: string;
  rationale?: string;
}) {
  return getDb()
    .insert(objectiveDependencies)
    .values({
      id: input.id,
      courseId: input.courseId,
      objectiveId: input.objectiveId,
      prerequisiteId: input.prerequisiteId,
      strength: input.strength ?? 'required',
      rationale: input.rationale ?? null,
    })
    .returning()
    .get();
}

export function listDependencies(courseId: string) {
  return getDb()
    .select()
    .from(objectiveDependencies)
    .where(eq(objectiveDependencies.courseId, courseId))
    .all();
}

export function deleteDependenciesByCourse(courseId: string) {
  return getDb().delete(objectiveDependencies).where(eq(objectiveDependencies.courseId, courseId)).run();
}

/* -------------------------------------------------------------- lessons ---- */

export function createLesson(input: {
  id: string;
  courseId: string;
  unitId: string;
  topicId?: string;
  ordinal: number;
  title: string;
  summary?: string;
  objectiveIds?: string;
  domainTemplate?: string;
  content?: string;
  estimatedMinutes?: number;
  classification?: string;
  status?: string;
  origin?: string;
}) {
  return getDb()
    .insert(lessons)
    .values({
      id: input.id,
      courseId: input.courseId,
      unitId: input.unitId,
      topicId: input.topicId ?? null,
      ordinal: input.ordinal,
      title: input.title,
      summary: input.summary ?? null,
      objectiveIds: input.objectiveIds ?? '[]',
      domainTemplate: input.domainTemplate ?? null,
      content: input.content ?? null,
      estimatedMinutes: input.estimatedMinutes ?? null,
      classification: input.classification ?? 'REQUIRED',
      status: input.status ?? 'pending',
      origin: input.origin ?? 'AI_GENERATED',
    })
    .returning()
    .get();
}

export function getLesson(id: string) {
  return getDb().select().from(lessons).where(eq(lessons.id, id)).get();
}

export function listLessons(courseId: string) {
  return getDb()
    .select()
    .from(lessons)
    .where(eq(lessons.courseId, courseId))
    .orderBy(asc(lessons.ordinal))
    .all();
}

export function listLessonsForUnit(unitId: string) {
  return getDb()
    .select()
    .from(lessons)
    .where(eq(lessons.unitId, unitId))
    .orderBy(asc(lessons.ordinal))
    .all();
}

export function deleteLessonsByCourse(courseId: string) {
  return getDb().delete(lessons).where(eq(lessons.courseId, courseId)).run();
}

export function updateLesson(id: string, data: Partial<{
  unitId: string;
  topicId: string | null;
  ordinal: number;
  title: string;
  summary: string;
  objectiveIds: string;
  domainTemplate: string;
  content: string;
  estimatedMinutes: number;
  classification: string;
  status: string;
  origin: string;
  contentHash: string;
}>) {
  return getDb()
    .update(lessons)
    .set({ ...data, updatedAt: Date.now() })
    .where(eq(lessons.id, id))
    .returning()
    .get();
}

/* ----------------------------------------------------------- activities ---- */

export function createActivity(input: {
  id: string;
  courseId: string;
  lessonId: string;
  ordinal: number;
  kind: string;
  title: string;
  payload?: string;
  origin?: string;
}) {
  return getDb()
    .insert(activities)
    .values({
      id: input.id,
      courseId: input.courseId,
      lessonId: input.lessonId,
      ordinal: input.ordinal,
      kind: input.kind,
      title: input.title,
      payload: input.payload ?? null,
      origin: input.origin ?? 'AI_GENERATED',
    })
    .returning()
    .get();
}

export function listActivitiesForLesson(lessonId: string) {
  return getDb()
    .select()
    .from(activities)
    .where(eq(activities.lessonId, lessonId))
    .orderBy(asc(activities.ordinal))
    .all();
}

export function deleteActivitiesByCourse(courseId: string) {
  return getDb().delete(activities).where(eq(activities.courseId, courseId)).run();
}

/* ------------------------------------------------------- practiceSets ---- */

export function createPracticeSet(input: {
  id: string;
  courseId: string;
  objectiveId?: string;
  lessonId?: string;
  ordinal?: number;
  title: string;
  level?: string;
  origin?: string;
}) {
  return getDb()
    .insert(practiceSets)
    .values({
      id: input.id,
      courseId: input.courseId,
      objectiveId: input.objectiveId ?? null,
      lessonId: input.lessonId ?? null,
      ordinal: input.ordinal ?? 0,
      title: input.title,
      level: input.level ?? 'independent',
      origin: input.origin ?? 'AI_GENERATED',
    })
    .returning()
    .get();
}

export function listPracticeSets(courseId: string) {
  return getDb()
    .select()
    .from(practiceSets)
    .where(eq(practiceSets.courseId, courseId))
    .orderBy(asc(practiceSets.ordinal))
    .all();
}

export function getPracticeSet(id: string) {
  return getDb().select().from(practiceSets).where(eq(practiceSets.id, id)).get();
}

export function deletePracticeSet(id: string) {
  return getDb().delete(practiceSets).where(eq(practiceSets.id, id)).run();
}

export function deletePracticeSetsByCourse(courseId: string) {
  return getDb().delete(practiceSets).where(eq(practiceSets.courseId, courseId)).run();
}

/* --------------------------------------------------------- assessments ---- */

export function createAssessment(input: {
  id: string;
  courseId: string;
  unitId?: string;
  kind: string;
  title: string;
  instructions?: string;
  objectiveIds?: string;
  passThreshold?: number;
  ordinal?: number;
  origin?: string;
}) {
  return getDb()
    .insert(assessments)
    .values({
      id: input.id,
      courseId: input.courseId,
      unitId: input.unitId ?? null,
      kind: input.kind,
      title: input.title,
      instructions: input.instructions ?? null,
      objectiveIds: input.objectiveIds ?? '[]',
      passThreshold: input.passThreshold ?? 0.8,
      ordinal: input.ordinal ?? 0,
      origin: input.origin ?? 'AI_GENERATED',
    })
    .returning()
    .get();
}

export function listAssessments(courseId: string) {
  return getDb()
    .select()
    .from(assessments)
    .where(eq(assessments.courseId, courseId))
    .orderBy(asc(assessments.ordinal))
    .all();
}

export function getAssessment(id: string) {
  return getDb().select().from(assessments).where(eq(assessments.id, id)).get();
}

export function deleteAssessment(id: string) {
  return getDb().delete(assessments).where(eq(assessments.id, id)).run();
}

export function deleteAssessmentsByCourse(courseId: string) {
  return getDb().delete(assessments).where(eq(assessments.courseId, courseId)).run();
}

/* ------------------------------------------------------------ questions ---- */

export function createQuestion(input: {
  id: string;
  courseId: string;
  objectiveId?: string;
  lessonId?: string;
  practiceSetId?: string;
  assessmentId?: string;
  ordinal?: number;
  kind: string;
  level?: string;
  prompt: string;
  choices?: string;
  answerKey?: string;
  explanation?: string;
  misconceptions?: string;
  expectedSkill?: string;
  difficulty?: number;
  origin?: string;
}) {
  return getDb()
    .insert(questions)
    .values({
      id: input.id,
      courseId: input.courseId,
      objectiveId: input.objectiveId ?? null,
      lessonId: input.lessonId ?? null,
      practiceSetId: input.practiceSetId ?? null,
      assessmentId: input.assessmentId ?? null,
      ordinal: input.ordinal ?? 0,
      kind: input.kind,
      level: input.level ?? 'independent',
      prompt: input.prompt,
      choices: input.choices ?? null,
      answerKey: input.answerKey ?? null,
      explanation: input.explanation ?? null,
      misconceptions: input.misconceptions ?? null,
      expectedSkill: input.expectedSkill ?? null,
      difficulty: input.difficulty ?? 3,
      origin: input.origin ?? 'AI_GENERATED',
    })
    .returning()
    .get();
}

export function listQuestions(courseId: string) {
  return getDb()
    .select()
    .from(questions)
    .where(eq(questions.courseId, courseId))
    .orderBy(asc(questions.ordinal))
    .all();
}

export function getQuestion(id: string) {
  return getDb().select().from(questions).where(eq(questions.id, id)).get();
}

export function listQuestionsForAssessment(assessmentId: string) {
  return getDb()
    .select()
    .from(questions)
    .where(eq(questions.assessmentId, assessmentId))
    .orderBy(asc(questions.ordinal))
    .all();
}

export function listQuestionsForObjective(objectiveId: string) {
  return getDb()
    .select()
    .from(questions)
    .where(eq(questions.objectiveId, objectiveId))
    .orderBy(asc(questions.ordinal))
    .all();
}

export function deleteQuestion(id: string) {
  return getDb().delete(questions).where(eq(questions.id, id)).run();
}

export function deleteQuestionsByCourse(courseId: string) {
  return getDb().delete(questions).where(eq(questions.courseId, courseId)).run();
}

export function updateQuestion(id: string, data: Partial<{
  ordinal: number;
  kind: string;
  level: string;
  prompt: string;
  choices: string;
  answerKey: string;
  explanation: string;
  misconceptions: string;
  expectedSkill: string;
  difficulty: number;
  origin: string;
}>) {
  return getDb()
    .update(questions)
    .set({ ...data, updatedAt: Date.now() })
    .where(eq(questions.id, id))
    .returning()
    .get();
}

/* ------------------------------------------------------- masteryRecords ---- */

export function createMasteryRecord(input: {
  id: string;
  courseId: string;
  userId: string;
  objectiveId: string;
  state?: string;
  score?: number;
}) {
  return getDb()
    .insert(masteryRecords)
    .values({
      id: input.id,
      courseId: input.courseId,
      userId: input.userId,
      objectiveId: input.objectiveId,
      state: input.state ?? 'NOT_STARTED',
      score: input.score ?? 0,
    })
    .returning()
    .get();
}

export function getMasteryRecord(courseId: string, userId: string, objectiveId: string) {
  return getDb()
    .select()
    .from(masteryRecords)
    .where(
      and(
        eq(masteryRecords.courseId, courseId),
        eq(masteryRecords.userId, userId),
        eq(masteryRecords.objectiveId, objectiveId),
      ),
    )
    .get();
}

export function listMasteryRecords(courseId: string, userId: string) {
  return getDb()
    .select()
    .from(masteryRecords)
    .where(
      and(eq(masteryRecords.courseId, courseId), eq(masteryRecords.userId, userId)),
    )
    .all();
}

export function updateMasteryRecord(id: string, data: Partial<{
  state: string;
  score: number;
  attemptCount: number;
  correctCount: number;
  evidenceCount: number;
  streak: number;
  lastAttemptAt: number;
  nextReviewAt: number;
  reviewIntervalDays: number;
}>) {
  return getDb()
    .update(masteryRecords)
    .set({ ...data, updatedAt: Date.now() })
    .where(eq(masteryRecords.id, id))
    .returning()
    .get();
}

/* ------------------------------------------------------ questionAttempts ---- */

export function createQuestionAttempt(input: {
  id: string;
  courseId: string;
  userId: string;
  questionId: string;
  objectiveId?: string;
  response?: string;
  isCorrect?: number;
  score?: number;
  misconceptionTag?: string;
  durationMs?: number;
}) {
  return getDb()
    .insert(questionAttempts)
    .values({
      id: input.id,
      courseId: input.courseId,
      userId: input.userId,
      questionId: input.questionId,
      objectiveId: input.objectiveId ?? null,
      response: input.response ?? null,
      isCorrect: input.isCorrect ?? 0,
      score: input.score ?? 0,
      misconceptionTag: input.misconceptionTag ?? null,
      durationMs: input.durationMs ?? null,
    })
    .returning()
    .get();
}

export function listQuestionAttempts(courseId: string, userId: string) {
  return getDb()
    .select()
    .from(questionAttempts)
    .where(
      and(eq(questionAttempts.courseId, courseId), eq(questionAttempts.userId, userId)),
    )
    .orderBy(desc(questionAttempts.createdAt))
    .all();
}

/* ----------------------------------------------------------- provenance ---- */

export function createProvenance(input: {
  id: string;
  courseId: string;
  entityType: string;
  entityId: string;
  fragmentId?: string;
  documentId?: string;
  relation: string;
  confidence?: number;
  note?: string;
}) {
  return getDb()
    .insert(provenance)
    .values({
      id: input.id,
      courseId: input.courseId,
      entityType: input.entityType,
      entityId: input.entityId,
      fragmentId: input.fragmentId ?? null,
      documentId: input.documentId ?? null,
      relation: input.relation,
      confidence: input.confidence ?? null,
      note: input.note ?? null,
    })
    .returning()
    .get();
}

export function listProvenanceForEntity(entityType: string, entityId: string) {
  return getDb()
    .select()
    .from(provenance)
    .where(and(eq(provenance.entityType, entityType), eq(provenance.entityId, entityId)))
    .all();
}

export function listProvenance(courseId: string) {
  return getDb()
    .select()
    .from(provenance)
    .where(eq(provenance.courseId, courseId))
    .all();
}

export function updateProvenance(id: string, data: Partial<{
  entityId: string;
  fragmentId: string;
  documentId: string;
  relation: string;
  confidence: number;
  note: string;
}>) {
  return getDb()
    .update(provenance)
    .set(data)
    .where(eq(provenance.id, id))
    .returning()
    .get();
}

/**
 * An assessment is written across a whole unit, so when the units are rebuilt
 * it is detached rather than deleted — the questions in it are still good.
 */
export function detachAssessmentsFromUnits(courseId: string) {
  return getDb()
    .update(assessments)
    .set({ unitId: null })
    .where(eq(assessments.courseId, courseId))
    .run();
}

/** Provenance for structure that is about to be deleted, e.g. old units. */
export function deleteProvenanceForEntity(entityType: string, entityId: string) {
  return getDb()
    .delete(provenance)
    .where(and(eq(provenance.entityType, entityType), eq(provenance.entityId, entityId)))
    .run();
}

export function deleteProvenanceByCourse(courseId: string) {
  return getDb().delete(provenance).where(eq(provenance.courseId, courseId)).run();
}

/* ----------------------------------------------------------- qaResults ---- */

export function createQaResult(input: {
  id: string;
  courseId: string;
  jobId?: string;
  runNumber?: number;
  checkKey: string;
  severity?: string;
  status: string;
  entityType?: string;
  entityId?: string;
  message: string;
  detail?: string;
  autoFixable?: number;
}) {
  return getDb()
    .insert(qaResults)
    .values({
      id: input.id,
      courseId: input.courseId,
      jobId: input.jobId ?? null,
      runNumber: input.runNumber ?? 1,
      checkKey: input.checkKey,
      severity: input.severity ?? 'warning',
      status: input.status,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      message: input.message,
      detail: input.detail ?? null,
      autoFixable: input.autoFixable ?? 0,
    })
    .returning()
    .get();
}

export function listQaResults(courseId: string) {
  return getDb()
    .select()
    .from(qaResults)
    .where(eq(qaResults.courseId, courseId))
    .orderBy(desc(qaResults.createdAt))
    .all();
}

/* ----------------------------------------------------- generationJobs ---- */

export function createGenerationJob(input: {
  id: string;
  courseId: string;
  userId: string;
  kind: string;
  requestKey?: string;
  input?: string;
}) {
  return getDb()
    .insert(generationJobs)
    .values({
      id: input.id,
      courseId: input.courseId,
      userId: input.userId,
      kind: input.kind,
      state: 'QUEUED',
      requestKey: input.requestKey ?? null,
      input: input.input ?? null,
    })
    .returning()
    .get();
}

export function getGenerationJob(id: string) {
  return getDb().select().from(generationJobs).where(eq(generationJobs.id, id)).get();
}

export function getGenerationJobByRequestKey(requestKey: string) {
  return getDb()
    .select()
    .from(generationJobs)
    .where(eq(generationJobs.requestKey, requestKey))
    .get();
}

/**
 * Release a finished job's requestKey so the same request can be made again.
 *
 * `request_key` carries a unique index, so a dead job would otherwise hold its
 * key forever and every retry would be handed the same failed job back.
 */
export function clearGenerationJobRequestKey(id: string) {
  return getDb()
    .update(generationJobs)
    .set({ requestKey: null })
    .where(eq(generationJobs.id, id))
    .run();
}

export function listGenerationJobs(courseId: string) {
  return getDb()
    .select()
    .from(generationJobs)
    .where(eq(generationJobs.courseId, courseId))
    .orderBy(desc(generationJobs.createdAt))
    .all();
}

/** List QUEUED jobs (oldest first) for the worker to pick up. */
export function listQueuedJobs(limit = 10) {
  return getDb()
    .select()
    .from(generationJobs)
    .where(eq(generationJobs.state, 'QUEUED'))
    .orderBy(asc(generationJobs.createdAt))
    .limit(limit)
    .all();
}

export function updateGenerationJob(id: string, data: Partial<{
  state: string;
  stage: string;
  progress: number;
  message: string;
  result: string;
  error: string;
  attempts: number;
  cancelRequested: number;
  startedAt: number;
  finishedAt: number;
}>) {
  return getDb()
    .update(generationJobs)
    .set({ ...data, updatedAt: Date.now() })
    .where(eq(generationJobs.id, id))
    .returning()
    .get();
}

/** List jobs in a given set of states, stale since `beforeMs` (for recovery). */
export function listAbandonedJobs(beforeMs: number, states: string[]) {
  if (states.length === 0) return [];
  return getDb()
    .select()
    .from(generationJobs)
    .where(
      and(
        lt(generationJobs.updatedAt, beforeMs),
        inArray(generationJobs.state, states),
      ),
    )
    .all();
}

/** Mark a job as cancelled if it is not already in a terminal state. */
export function cancelGenerationJob(id: string) {
  const job = getDb().select().from(generationJobs).where(eq(generationJobs.id, id)).get();
  if (!job) return null;
  if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.state)) return job;
  return getDb()
    .update(generationJobs)
    .set({ state: 'CANCELLED', cancelRequested: 1, finishedAt: Date.now(), updatedAt: Date.now() })
    .where(eq(generationJobs.id, id))
    .returning()
    .get();
}

/** Atomically claim a QUEUED job for execution (prevents double execution). */
export function claimQueuedJob(id: string) {
  return getDb()
    .update(generationJobs)
    .set({ startedAt: Date.now(), attempts: 1 + 0, updatedAt: Date.now() })
    .where(eq(generationJobs.id, id))
    .returning()
    .get();
}

/* --------------------------------------------------- generationEvents ---- */

export function createGenerationEvent(input: {
  id: string;
  jobId: string;
  courseId: string;
  ordinal: number;
  stage: string;
  level?: string;
  message: string;
  model?: string;
  provider?: string;
  latencyMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  retryCount?: number;
  schemaFailures?: number;
}) {
  return getDb()
    .insert(generationEvents)
    .values({
      id: input.id,
      jobId: input.jobId,
      courseId: input.courseId,
      ordinal: input.ordinal,
      stage: input.stage,
      level: input.level ?? 'info',
      message: input.message,
      model: input.model ?? null,
      provider: input.provider ?? null,
      latencyMs: input.latencyMs ?? null,
      promptTokens: input.promptTokens ?? null,
      completionTokens: input.completionTokens ?? null,
      retryCount: input.retryCount ?? null,
      schemaFailures: input.schemaFailures ?? null,
    })
    .returning()
    .get();
}

export function listGenerationEvents(jobId: string) {
  return getDb()
    .select()
    .from(generationEvents)
    .where(eq(generationEvents.jobId, jobId))
    .orderBy(asc(generationEvents.ordinal))
    .all();
}

/* --------------------------------------------------------- userEdits ---- */

export function createUserEdit(input: {
  id: string;
  courseId: string;
  userId: string;
  entityType: string;
  entityId: string;
  field: string;
  previousValue?: string;
  newValue?: string;
}) {
  return getDb()
    .insert(userEdits)
    .values({
      id: input.id,
      courseId: input.courseId,
      userId: input.userId,
      entityType: input.entityType,
      entityId: input.entityId,
      field: input.field,
      previousValue: input.previousValue ?? null,
      newValue: input.newValue ?? null,
    })
    .returning()
    .get();
}

export function listUserEdits(courseId: string) {
  return getDb()
    .select()
    .from(userEdits)
    .where(eq(userEdits.courseId, courseId))
    .orderBy(desc(userEdits.createdAt))
    .all();
}

export function getUserEditsForEntity(courseId: string, entityType: string, entityId: string) {
  return getDb()
    .select()
    .from(userEdits)
    .where(
      and(
        eq(userEdits.courseId, courseId),
        eq(userEdits.entityType, entityType),
        eq(userEdits.entityId, entityId),
      ),
    )
    .orderBy(desc(userEdits.createdAt))
    .all();
}