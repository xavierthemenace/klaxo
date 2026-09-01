/**
 * Domain types shared across the AI service layer.
 *
 * These are the structured contracts exchanged between pipeline stages. Each
 * stage accepts an explicit input type and produces an explicit output type,
 * all validated with Zod where they cross a trust boundary (AI output).
 */
import { z } from 'zod';

/* ------------------------------------------------------------ source ---- */

export const ClassifiedContentSchema = z.enum([
  'REQUIRED',
  'PREREQUISITE',
  'RECOMMENDED',
  'ENRICHMENT',
]);

export const DifficultySchema = z.number().int().min(1).max(5);
export const ImportanceSchema = z.number().int().min(1).max(5);

/** A detected unit from source extraction. */
export const DetectedUnitSchema = z.object({
  title: z.string(),
  ordinal: z.number().int(),
  description: z.string().optional(),
  classification: ClassifiedContentSchema.default('REQUIRED'),
});

/** A detected learning objective from source extraction. */
export const DetectedObjectiveSchema = z.object({
  statement: z.string(),
  category: z.string().default('skill'),
  difficulty: DifficultySchema.default(3),
  importance: ImportanceSchema.default(3),
  classification: ClassifiedContentSchema.default('REQUIRED'),
  sourceFragmentIds: z.array(z.string()).default([]),
});

/** A detected terminology term. */
export const DetectedTermSchema = z.object({
  term: z.string(),
  definition: z.string().optional(),
  domain: z.string().optional(),
});

/** An ambiguity/uncertainty flagged during extraction. */
export const AmbiguitySchema = z.object({
  id: z.string(),
  location: z.string().optional(),
  description: z.string(),
  confidence: z.number().min(0).max(1),
  suggestion: z.string().optional(),
});

/** The structured result of source analysis. */
export const SourceAnalysisSchema = z.object({
  title: z.string(),
  subject: z.string().default('general'),
  level: z.string().default('introductory'),
  summary: z.string().default(''),
  units: z.array(DetectedUnitSchema).default([]),
  objectives: z.array(DetectedObjectiveSchema).default([]),
  terminology: z.array(DetectedTermSchema).default([]),
  requirements: z.array(z.string()).default([]),
  prerequisites: z.array(z.string()).default([]),
  ambiguities: z.array(AmbiguitySchema).default([]),
  confidence: z.number().min(0).max(1).default(0),
});

export type SourceAnalysis = z.infer<typeof SourceAnalysisSchema>;
export type DetectedUnit = z.infer<typeof DetectedUnitSchema>;
export type DetectedObjective = z.infer<typeof DetectedObjectiveSchema>;

/* ---------------------------------------------------------- blueprint ---- */

/** A topic within a unit, in the curriculum blueprint. */
export const BlueprintTopicSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  classification: ClassifiedContentSchema.default('REQUIRED'),
});

/** A learning objective in the blueprint. */
export const BlueprintObjectiveSchema = z.object({
  id: z.string().optional(),
  statement: z.string(),
  category: z.string().default('skill'),
  difficulty: DifficultySchema.default(3),
  importance: ImportanceSchema.default(3),
  classification: ClassifiedContentSchema.default('REQUIRED'),
});

/** A unit in the curriculum blueprint. */
export const BlueprintUnitSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  classification: ClassifiedContentSchema.default('REQUIRED'),
  topics: z.array(BlueprintTopicSchema).default([]),
  objectives: z.array(BlueprintObjectiveSchema).default([]),
  estimatedMinutes: z.number().int().positive().optional(),
});

/** Dependency edge between objectives. */
export const PrerequisiteEdgeSchema = z.object({
  objectiveId: z.string(),
  prerequisiteId: z.string(),
  strength: z.enum(['required', 'helpful']).default('required'),
  rationale: z.string().optional(),
});

/** The full curriculum blueprint. */
export const CurriculumBlueprintSchema = z.object({
  title: z.string(),
  description: z.string().default(''),
  intendedLearner: z.string().default(''),
  assumedKnowledge: z.string().default(''),
  units: z.array(BlueprintUnitSchema).default([]),
  prerequisites: z.array(PrerequisiteEdgeSchema).default([]),
  estimatedMinutes: z.number().int().positive().optional(),
  classifications: z
    .object({
      required: z.array(z.string()).default([]),
      prerequisite: z.array(z.string()).default([]),
      recommended: z.array(z.string()).default([]),
      enrichment: z.array(z.string()).default([]),
    })
    .default({ required: [], prerequisite: [], recommended: [], enrichment: [] }),
});

export type CurriculumBlueprint = z.infer<typeof CurriculumBlueprintSchema>;
export type BlueprintUnit = z.infer<typeof BlueprintUnitSchema>;
export type BlueprintObjective = z.infer<typeof BlueprintObjectiveSchema>;
export type PrerequisiteEdge = z.infer<typeof PrerequisiteEdgeSchema>;

/* ------------------------------------------------------------ lesson ---- */

/** A misconception entry used for diagnostics and remediation. */
export const MisconceptionSchema = z.object({
  misconception: z.string(),
  correction: z.string(),
  distractorId: z.string().optional(),
});

/** A visual specification (never a raw image, always structured). */
export const VisualSpecSchema = z.object({
  type: z.string(),
  purpose: z.string(),
  subject: z.string(),
  labels: z.array(z.string()).default([]),
  caption: z.string(),
  objectiveId: z.string().optional(),
});

/** A lesson section. */
export const LessonSectionSchema = z.object({
  id: z.string().optional(),
  type: z.enum([
    'objective',
    'prerequisite_review',
    'motivation',
    'intuition',
    'explanation',
    'definition',
    'example',
    'worked_example',
    'visual',
    'misconception',
    'guided_practice',
    'independent_practice',
    'challenge',
    'retrieval',
    'summary',
    'mastery_check',
  ])
    // An unfamiliar label like "introduction" or "key_takeaways" is a naming
    // difference, not a content failure. Rejecting it threw away the whole
    // lesson over one word.
    .catch('explanation'),
  title: z.string(),
  content: z.string(),
  visual: VisualSpecSchema.optional(),
});

/** Full generated lesson content. */
export const LessonContentSchema = z.object({
  objectives: z.array(z.string()).default([]),
  // Required, and non-empty. With everything optional, any JSON object at all
  // validated — a wrapped `{"lesson": {…}}` reply, or even a blueprint — and
  // the pipeline happily published an empty lesson and reported success.
  sections: z.array(LessonSectionSchema).min(1),
  misconceptions: z.array(MisconceptionSchema).default([]),
  visuals: z.array(VisualSpecSchema).default([]),
  masteryCheck: z
    .object({
      prompt: z.string(),
      criteria: z.string(),
    })
    .optional(),
  summary: z.string().min(1),
  estimatedMinutes: z.number().int().positive().optional(),
});

export type LessonContent = z.infer<typeof LessonContentSchema>;
export type LessonSection = z.infer<typeof LessonSectionSchema>;
export type Misconception = z.infer<typeof MisconceptionSchema>;
export type VisualSpec = z.infer<typeof VisualSpecSchema>;

/* --------------------------------------------------------- assessment ---- */

/** A question choice (for MCQ). */
export const ChoiceSchema = z.object({
  text: z.string(),
  isCorrect: z.boolean(),
});

/** A single question. */
export const QuestionSchema = z.object({
  kind: z
    .enum(['mcq', 'short_answer', 'numeric', 'proof', 'code', 'essay', 'matching', 'ordering'])
    // `true_false` and `fill_in_blank` come back often and are answered like a
    // short answer. Better that than losing the whole set.
    .catch('short_answer'),
  prompt: z.string(),
  // The answer to a numeric question is a number, and to a short answer a
  // string. Insisting on an object failed a whole set over one question.
  answerKey: z
    .union([
      z.record(z.string(), z.unknown()),
      z.string(),
      z.number(),
      z.boolean(),
      z.array(z.unknown()),
    ])
    .optional(),
  choices: z.array(ChoiceSchema).optional(),
  explanation: z.string().optional(),
  misconceptions: z.array(z.string()).default([]),
  expectedSkill: z.string().optional(),
  level: z.enum(['recognition', 'guided', 'independent', 'application', 'transfer', 'challenge']).default('independent'),
  difficulty: DifficultySchema.default(3),
});

/** Practice set with progressive levels. */
export const PracticeSetSchema = z.object({
  title: z.string(),
  level: z.enum(['recognition', 'guided', 'independent', 'application', 'transfer', 'challenge']).default('independent'),
  objectiveId: z.string().optional(),
  // Required and non-empty: a reply that named the array `problems` used to
  // validate as a practice set with no questions in it.
  questions: z.array(QuestionSchema).min(1),
});

/** Assessment with aligned questions. */
export const AssessmentSchema = z.object({
  kind: z.enum(['diagnostic', 'formative', 'unit', 'checkpoint', 'cumulative', 'final']),
  title: z.string(),
  instructions: z.string().optional(),
  objectiveIds: z.array(z.string()).default([]),
  questions: z.array(QuestionSchema).min(1),
  passThreshold: z.number().min(0).max(1).default(0.8),
});

export type Question = z.infer<typeof QuestionSchema>;
export type Choice = z.infer<typeof ChoiceSchema>;
export type PracticeSet = z.infer<typeof PracticeSetSchema>;
export type Assessment = z.infer<typeof AssessmentSchema>;

/* ------------------------------------------------------------------ QA ---- */

/** A single QA check result. */
export const QaCheckSchema = z.object({
  checkKey: z.string(),
  severity: z.enum(['info', 'warning', 'error']).default('warning'),
  status: z.enum(['pass', 'fail']),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
  message: z.string(),
  detail: z.record(z.string(), z.unknown()).optional(),
  autoFixable: z.boolean().default(false),
});

/** A QA run result. */
export const QaResultSchema = z.object({
  // Required, so a reply like {"verdict":"looks good"} cannot pass as a clean
  // QA run that checked nothing.
  checks: z.array(QaCheckSchema),
  summary: z.string().min(1),
  passRate: z.number().min(0).max(1).optional(),
});

export type QaCheck = z.infer<typeof QaCheckSchema>;
export type QaResult = z.infer<typeof QaResultSchema>;

/* ---------------------------------------------------------- generation ---- */

/** Job kinds for long-running generation. */
export const JobKindSchema = z.enum([
  'ANALYZE_SOURCE',
  'BLUEPRINT',
  'GENERATE_COURSE',
  'REGENERATE_LESSON',
  'REPLAN',
  'QA',
  'REVISE',
]);

export const JobStateSchema = z.enum([
  'QUEUED',
  'ANALYZING',
  'PLANNING',
  'GENERATING',
  'VALIDATING',
  'REVISING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);

export type JobKind = z.infer<typeof JobKindSchema>;
export type JobState = z.infer<typeof JobStateSchema>;

/* ------------------------------------------------------------- mastery ---- */

export const MasteryStateSchema = z.enum([
  'NOT_STARTED',
  'INTRODUCED',
  'PRACTICING',
  'PROVISIONAL',
  'MASTERED',
  'NEEDS_REVIEW',
]);

export type MasteryState = z.infer<typeof MasteryStateSchema>;