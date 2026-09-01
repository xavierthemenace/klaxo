'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Badge } from '@/components/ui/Badge';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { StepIndicator } from '@/components/wizard/StepIndicator';
import { unitDisplayTitle } from '@/components/workspace/helpers';
import { WizardStep } from '@/components/wizard/WizardStep';
import { FileUpload, type PersistedSource } from '@/components/wizard/FileUpload';
import { cn } from '@/lib/cn';

/* ------------------------------------------------------------------ types ---- */

interface Course {
  id: string;
  title: string;
  description: string | null;
  subjectDomain: string | null;
  targetLevel: string | null;
  status: string;
  stage: string;
  preferences: string | null;
}

interface Job {
  id: string;
  kind: string;
  state: string;
  stage: string | null;
  progress: number;
  message: string | null;
  /** JSON payload a finished job leaves behind, e.g. a replan's counts. */
  result?: string | null;
}

interface DetectedUnit {
  title: string;
  ordinal: number;
  description?: string;
  classification?: string;
  objectiveIds?: string[];
}

interface DetectedObjective {
  statement: string;
  category?: string;
  difficulty?: number;
  importance?: number;
  classification?: string;
  sourceFragmentIds?: string[];
}

interface DetectedTerm {
  term: string;
  definition?: string;
  domain?: string;
}

interface Ambiguity {
  id: string;
  location?: string;
  description: string;
  confidence: number;
  suggestion?: string;
}

interface SourceAnalysis {
  title: string;
  subject: string;
  level: string;
  summary: string;
  units: DetectedUnit[];
  objectives: DetectedObjective[];
  terminology: DetectedTerm[];
  requirements: string[];
  prerequisites: string[];
  ambiguities: Ambiguity[];
  confidence: number;
}

interface KnowledgePackage {
  id: string;
  status: string;
  detectedTitle: string | null;
  detectedSubject: string | null;
  detectedLevel: string | null;
  summary: string | null;
  analysis: SourceAnalysis;
}

interface SourceFragment {
  id: string;
  documentId: string;
  kind: string;
  text: string;
  page: number | null;
  confidence: number | null;
  uncertain: number;
}

interface UnitEntity {
  id: string;
  ordinal: number;
  title: string;
  description: string | null;
  classification: string;
}

interface ObjectiveEntity {
  id: string;
  unitId: string | null;
  topicId: string | null;
  ordinal: number;
  code: string | null;
  title: string;
  statement: string;
  classification: string;
}

interface WorkspaceData {
  units: UnitEntity[];
  objectives: ObjectiveEntity[];
  lessons: { id: string }[];
  assessments: { id: string }[];
  questions: { id: string }[];
}

/* ------------------------------------------------------------ constants ---- */

const WIZARD_STEPS = [
  // Named for what happens on them, not for the pipeline stage behind them.
  { id: 'info', label: 'Subject' },
  { id: 'sources', label: 'Your material' },
  { id: 'understanding', label: 'Check' },
  { id: 'preferences', label: 'How you learn' },
  { id: 'blueprint', label: 'The plan' },
  { id: 'generation', label: 'Write it' },
  { id: 'qa', label: 'Marking' },
  { id: 'workspace', label: 'Done' },
] as const;

type StepId = (typeof WIZARD_STEPS)[number]['id'];

/** Generation pipeline stages, in order. */
const GENERATION_PIPELINE: { stage: string; label: string }[] = [
  { stage: 'blueprint', label: 'Blueprint' },
  { stage: 'lessons', label: 'Lessons' },
  { stage: 'practice', label: 'Practice' },
  { stage: 'assessments', label: 'Assessments' },
  { stage: 'revision', label: 'Marking' },
  { stage: 'complete', label: 'Done' },
];

const TERMINAL_STATES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

const STEP_KEYS = Object.keys(Object.fromEntries(WIZARD_STEPS.map((s) => [s.id, true]))) as StepId[];

/** Steps you can walk straight past without doing anything. */
const OPTIONAL_STEPS = new Set<StepId>(['preferences']);

/* ---------------------------------------------------------------- page ---- */

export default function WizardPage() {
  const router = useRouter();
  const params = useParams();
  const courseId = params.id as string;

  // Course-level fields (autosaved on blur).
  const [course, setCourse] = useState<Course | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [subjectDomain, setSubjectDomain] = useState('');
  const [targetLevel, setTargetLevel] = useState('');
  const [preferencesNote, setPreferencesNote] = useState('');
  const [preferencesError, setPreferencesError] = useState<string | null>(null);

  // Navigation / stepper.
  const [currentStep, setCurrentStep] = useState<StepId>('info');
  const [completedSteps, setCompletedSteps] = useState<StepId[]>([]);
  /** Set once the first load finishes, so progress can be read off the course. */
  const [warningSteps, setWarningSteps] = useState<StepId[]>([]);
  const [errorSteps, setErrorSteps] = useState<StepId[]>([]);

  // Loading/global.
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Sources.
  const [sources, setSources] = useState<PersistedSource[]>([]);

  // Source understanding.
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState(0);
  const [analysisMessage, setAnalysisMessage] = useState('');
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [knowledgePackage, setKnowledgePackage] = useState<KnowledgePackage | null>(null);
  const [fragments, setFragments] = useState<SourceFragment[]>([]);
  const [editTitle, setEditTitle] = useState('');
  const [editSubject, setEditSubject] = useState('');
  const [editLevel, setEditLevel] = useState('');
  const [editSummary, setEditSummary] = useState('');
  const [approving, setApproving] = useState(false);

  // Blueprint.
  const [blueprinting, setBlueprinting] = useState(false);
  const [blueprintProgress, setBlueprintProgress] = useState(0);
  const [blueprintMessage, setBlueprintMessage] = useState('');
  /** Kept separately from the progress message: that one disappears when the
      job stops running, which is exactly when a failure needs to be read. */
  const [blueprintError, setBlueprintError] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceData | null>(null);
  const alreadyBuilt = (workspace?.objectives.length ?? 0) > 0;
  const [replanning, setReplanning] = useState(false);
  const [replanMessage, setReplanMessage] = useState<string | null>(null);
  const [replanSummary, setReplanSummary] = useState<string | null>(null);

  // Generation.
  const [generating, setGenerating] = useState(false);
  const [generationStage, setGenerationStage] = useState('');
  const [generationProgress, setGenerationProgress] = useState(0);
  const [generationMessage, setGenerationMessage] = useState('');
  const [qaWarning, setQaWarning] = useState(false);

  // Refs to avoid stale closures inside the polling loop.
  const mountedRef = useRef(true);
  const courseRef = useRef<Course | null>(null);
  const kpRef = useRef<KnowledgePackage | null>(null);
  const workspaceRef = useRef<WorkspaceData | null>(null);
  const activePollRef = useRef<number | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (activePollRef.current !== null) {
        window.clearTimeout(activePollRef.current);
      }
    };
  }, []);

  /* ---------------------------------------------------------- helpers ---- */

  const markCompleted = useCallback((step: StepId) => {
    setCompletedSteps((prev) => (prev.includes(step) ? prev : [...prev, step]));
  }, []);

  const setStepWarning = useCallback((step: StepId, warned: boolean) => {
    setWarningSteps((prev) =>
      warned ? (prev.includes(step) ? prev : [...prev, step]) : prev.filter((s) => s !== step),
    );
  }, []);

  const setStepError = useCallback((step: StepId, errored: boolean) => {
    setErrorSteps((prev) =>
      errored ? (prev.includes(step) ? prev : [...prev, step]) : prev.filter((s) => s !== step),
    );
    if (errored) {
      setWarningSteps((prev) => prev.filter((s) => s !== step));
    }
  }, []);

  const canVisit = useCallback(
    (step: StepId): boolean => {
      const idx = STEP_KEYS.indexOf(step);
      const currentIdx = STEP_KEYS.indexOf(currentStep);
      if (idx <= currentIdx) return true;
      // A step that failed has to be dealt with first. Walking past it just
      // lands on a screen that says "No interpretation approved yet".
      if (errorSteps.includes(currentStep)) return false;
      // Forward navigation is allowed only into the immediate next step.
      if (idx === currentIdx + 1) return true;
      // Or into any already-completed step.
      return completedSteps.includes(step);
    },
    [currentStep, completedSteps, errorSteps],
  );

  const goToStep = useCallback(
    (step: StepId) => {
      if (!canVisit(step)) return;
      const from = STEP_KEYS.indexOf(currentStep);
      const to = STEP_KEYS.indexOf(step);
      // Stepping forward past an optional step counts as finishing it.
      if (to > from && OPTIONAL_STEPS.has(currentStep)) markCompleted(currentStep);
      setCurrentStep(step);
    },
    [canVisit, currentStep, markCompleted],
  );

  const fetchCourse = useCallback(async () => {
    try {
      const res = await fetch(`/api/courses/${courseId}`);
      if (!res.ok) throw new Error('Failed to load course');
      const data = await res.json();
      const c: Course = data.course;
      if (!mountedRef.current) return;
      setCourse(c);
      courseRef.current = c;
      setTitle(c.title ?? '');
      setDescription(c.description ?? '');
      setSubjectDomain(c.subjectDomain ?? '');
      setTargetLevel(c.targetLevel ?? '');

      if (c.preferences) {
        try {
          const prefs = JSON.parse(c.preferences) as Record<string, unknown>;
          setPreferencesNote(typeof prefs.note === 'string' ? prefs.note : '');
        } catch {
          setPreferencesNote('');
        }
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [courseId]);

  const saveCourse = useCallback(
    // Returns whether the save actually landed, so callers never tick a step
    // green off the back of a rejected request.
    async (patch: Record<string, unknown>): Promise<boolean> => {
      setSaving(true);
      try {
        const res = await fetch(`/api/courses/${courseId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (!res.ok) throw new Error('Failed to save');
        const data = await res.json();
        if (mountedRef.current) {
          setCourse(data.course);
          courseRef.current = data.course;
        }
        return true;
      } catch {
        // Non-fatal autosave error; leave local state intact.
        return false;
      } finally {
        if (mountedRef.current) setSaving(false);
      }
    },
    [courseId],
  );

  /* --------------------------------------------------- polling helper ---- */

  const pollJob = useCallback(
    (
      jobId: string,
      kind: string,
      onTick: (job: Job) => void,
      onDone: (job: Job) => void,
      onFailed?: (job: Job) => void,
    ): Promise<void> => {
      return new Promise<void>((resolve) => {
        const tick = async () => {
          if (!mountedRef.current) return resolve();
          try {
            const res = await fetch(`/api/courses/${courseId}/jobs`);
            if (!res.ok) throw new Error('Failed to poll jobs');
            const data = await res.json();
            const jobs: Job[] = data.jobs ?? [];
            const job = jobs.find((j) => j.id === jobId) ?? jobs.find((j) => j.kind === kind);

            if (!job) {
              // Job not yet visible; retry shortly.
              activePollRef.current = window.setTimeout(tick, 1200);
              return;
            }

            onTick(job);

            if (TERMINAL_STATES.has(job.state)) {
              if (job.state === 'COMPLETED') onDone(job);
              else if (job.state === 'FAILED' && onFailed) onFailed(job);
              else onDone(job);
              return resolve();
            }

            activePollRef.current = window.setTimeout(tick, 1200);
          } catch {
            activePollRef.current = window.setTimeout(tick, 1500);
          }
        };
        activePollRef.current = window.setTimeout(tick, 600);
      });
    },
    [courseId],
  );

  const fetchKnowledgePackage = useCallback(async () => {
    try {
      const res = await fetch(`/api/courses/${courseId}/knowledge-package`);
      if (!res.ok) return;
      const data = await res.json();
      if (!mountedRef.current) return;
      const kp: KnowledgePackage | null = data.knowledgePackage ?? null;
      kpRef.current = kp;
      setKnowledgePackage(kp);
      setFragments((data.fragments ?? []) as SourceFragment[]);
      if (kp) {
        setEditTitle(kp.detectedTitle ?? kp.analysis.title ?? '');
        setEditSubject(kp.detectedSubject ?? kp.analysis.subject ?? '');
        setEditLevel(kp.detectedLevel ?? kp.analysis.level ?? '');
        setEditSummary(kp.summary ?? kp.analysis.summary ?? '');
        if (kp.status === 'approved') {
          markCompleted('understanding');
        }
      }
    } catch {
      /* ignore */
    }
  }, [courseId, markCompleted]);

  const fetchWorkspace = useCallback(async () => {
    try {
      const res = await fetch(`/api/courses/${courseId}/workspace`);
      if (!res.ok) return;
      const data = await res.json();
      if (mountedRef.current) {
        const next = {
          units: data.units ?? [],
          objectives: data.objectives ?? [],
          lessons: data.lessons ?? [],
          assessments: data.assessments ?? [],
          questions: data.questions ?? [],
        };
        workspaceRef.current = next;
        setWorkspace(next);
      }
    } catch {
      /* ignore */
    }
  }, [courseId]);

  /* ------------------------------------------------------- initial load ---- */

  /**
   * Work out what has already been done from the course itself.
   *
   * Completion used to live only in component state, so reopening a finished
   * course showed every step padlocked, as though nothing had ever been built.
   * The course knows perfectly well what it has: sources, an approved
   * interpretation, units, lessons. Read it from there, once, on load, and drop
   * the reader at the first thing still outstanding.
   */
  const restoreProgress = useCallback(async () => {
    let sourceCount = 0;
    try {
      const res = await fetch(`/api/courses/${courseId}/sources`);
      if (res.ok) sourceCount = ((await res.json()).sources ?? []).length;
    } catch {
      /* a failed count just means we assume nothing was added */
    }
    if (!mountedRef.current) return;

    const done: StepId[] = ['info'];
    if (sourceCount > 0) done.push('sources');
    if (kpRef.current?.status === 'approved') done.push('understanding');
    if ((workspaceRef.current?.units.length ?? 0) > 0) done.push('preferences', 'blueprint');
    if ((workspaceRef.current?.lessons.length ?? 0) > 0) done.push('generation', 'qa');

    setCompletedSteps((prev) => Array.from(new Set([...prev, ...done])));
    setCurrentStep(STEP_KEYS.find((step) => !done.includes(step)) ?? 'workspace');
  }, [courseId]);

  useEffect(() => {
    fetchCourse()
      .then(fetchKnowledgePackage)
      .then(fetchWorkspace)
      .then(restoreProgress)
      .catch(() => {
        if (mountedRef.current) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId]);

  /* ----------------------------------------------------- step handlers ---- */

  const handleAnalyze = async () => {
    if (sources.length === 0) return;
    setAnalyzing(true);
    setAnalysisProgress(0);
    setAnalysisMessage('Starting analysis…');
    setAnalysisError(null);
    setStepError('understanding', false);
    try {
      const res = await fetch(`/api/courses/${courseId}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentIds: sources.map((s) => s.documentId) }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? 'Analysis request failed');
      }
      const { jobId } = (await res.json()) as { jobId: string };

      await pollJob(
        jobId,
        'ANALYZE_SOURCE',
        (job) => {
          setAnalysisProgress(job.progress);
          setAnalysisMessage(job.message ?? 'Analyzing…');
        },
        async () => {
          await fetchKnowledgePackage();
          markCompleted('understanding');
        },
        (job) => {
          setStepError('understanding', true);
          setAnalysisMessage(job.message ?? 'Analysis failed');
          setAnalysisError(job.message ?? 'It could not read your material.');
        },
      );
    } catch (err) {
      setStepError('understanding', true);
      setAnalysisMessage((err as Error).message);
      setAnalysisError((err as Error).message);
    } finally {
      setAnalyzing(false);
    }
  };

  const handleApprove = async () => {
    setApproving(true);
    try {
      const res = await fetch(`/api/courses/${courseId}/knowledge-package`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'approved',
          detectedTitle: editTitle,
          detectedSubject: editSubject,
          detectedLevel: editLevel,
          summary: editSummary,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? 'Failed to approve');
      }
      // Fill course fields from the approved interpretation, but never
      // overwrite something the user already typed in Course Info.
      const hasCustomTitle = title.trim() !== '' && title.trim() !== 'Untitled Course';
      await saveCourse({
        ...(editTitle && !hasCustomTitle ? { title: editTitle } : {}),
        ...(editSubject && !subjectDomain.trim() ? { subjectDomain: editSubject } : {}),
        ...(editLevel && !targetLevel.trim() ? { targetLevel: editLevel } : {}),
      });
      await fetchKnowledgePackage();
      markCompleted('understanding');
    } catch (err) {
      setAnalysisMessage((err as Error).message);
    } finally {
      setApproving(false);
    }
  };

  const handleSavePreferences = async () => {
    // The API takes an object here and stringifies it itself. Sending a string
    // was rejected with a 400 and the tick below still ran, so the step looked
    // saved when nothing had been.
    const ok = await saveCourse({ preferences: { note: preferencesNote } });
    if (ok) {
      setPreferencesError(null);
      markCompleted('preferences');
    } else {
      setPreferencesError('That did not save. Try again.');
    }
  };

  const handleGenerateBlueprint = async () => {
    setBlueprinting(true);
    setBlueprintProgress(0);
    setBlueprintMessage('Designing curriculum…');
    setBlueprintError(null);
    setStepError('blueprint', false);
    try {
      const res = await fetch(`/api/courses/${courseId}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'BLUEPRINT' }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? 'Blueprint request failed');
      }
      const { jobId } = (await res.json()) as { jobId: string };

      await pollJob(
        jobId,
        'BLUEPRINT',
        (job) => {
          setBlueprintProgress(job.progress);
          setBlueprintMessage(job.message ?? 'Building blueprint…');
        },
        async () => {
          await fetchWorkspace();
          markCompleted('blueprint');
        },
        (job) => {
          setStepError('blueprint', true);
          setBlueprintMessage(job.message ?? 'Blueprint failed');
          setBlueprintError(job.message ?? 'The blueprint could not be built.');
        },
      );
    } catch (err) {
      setStepError('blueprint', true);
      setBlueprintMessage((err as Error).message);
    } finally {
      setBlueprinting(false);
    }
  };

  /**
   * Fold newly added material into a course that is already built.
   *
   * The job does the whole thing server-side: re-reads every source, snapshots
   * the course, merges the new plan into the old one, and writes lessons only
   * for objectives that did not exist before. Everything already practised
   * keeps its progress.
   */
  const handleReplan = async () => {
    setReplanning(true);
    setReplanMessage('Reading the new material…');
    setReplanSummary(null);
    try {
      const res = await fetch(`/api/courses/${courseId}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'REPLAN' }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? 'Update request failed');
      }
      const { jobId } = (await res.json()) as { jobId: string };

      await pollJob(
        jobId,
        'REPLAN',
        (job) => setReplanMessage(job.message ?? 'Updating…'),
        async (job) => {
          try {
            const summary = job.result ? JSON.parse(job.result) : null;
            if (summary) {
              setReplanSummary(
                `Kept ${summary.kept}, added ${summary.added}, removed ${summary.removed}.`,
              );
            }
          } catch {
            setReplanSummary('Course updated.');
          }
          setReplanMessage('Course updated.');
          await fetchWorkspace();
        },
        (job) => setReplanMessage(job.message ?? 'Update failed'),
      );
    } catch (err) {
      setReplanMessage((err as Error).message);
    } finally {
      setReplanning(false);
    }
  };

  const handleGenerateCourse = async () => {
    setGenerating(true);
    setGenerationStage('blueprint');
    setGenerationProgress(0);
    setGenerationMessage('Starting generation…');
    setQaWarning(false);
    setStepError('generation', false);
    setStepError('qa', false);
    try {
      const res = await fetch(`/api/courses/${courseId}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'GENERATE_COURSE' }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? 'Generation request failed');
      }
      const { jobId } = (await res.json()) as { jobId: string };

      await pollJob(
        jobId,
        'GENERATE_COURSE',
        (job) => {
          setGenerationStage(job.stage ?? '');
          setGenerationProgress(job.progress);
          setGenerationMessage(job.message ?? 'Generating…');
        },
        async (job) => {
          // Determine whether QA left remaining issues from the job result.
          const result = parseJobQaWarning(job);
          setQaWarning(result);
          if (result) setStepWarning('qa', true);
          await fetchWorkspace();
          markCompleted('generation');
          markCompleted('qa');
        },
        (job) => {
          setStepError('generation', true);
          setGenerationMessage(job.message ?? 'Generation failed');
        },
      );
    } catch (err) {
      setStepError('generation', true);
      setGenerationMessage((err as Error).message);
    } finally {
      setGenerating(false);
    }
  };

  /* -------------------------------------------------- derived helpers ---- */

  function parseJobQaWarning(job: Job): boolean {
    // The job result JSON is not returned by GET /jobs, but the message often
    // carries QA specifics. If the job completed with a stage of 'revision'
    // or 'complete' and a non-empty message mentioning remaining issues, flag it.
    const msg = (job.message ?? '').toLowerCase();
    if (!msg) return false;
    return (
      msg.includes('remain') ||
      msg.includes('may need manual review') ||
      msg.includes('issue') ||
      msg.includes('revision bound')
    );
  }

  /* -------------------------------------------------------- initial ---- */

  if (loading) {
    return (
      <div className="container mx-auto py-8 px-4 max-w-4xl">
        <Skeleton className="h-8 w-64 mb-4" />
        <Skeleton className="h-16 mb-8" />
        <Skeleton className="h-96" />
      </div>
    );
  }

  if (!course) {
    return (
      <div className="container mx-auto py-8 px-4 text-center">
        <h1 className="text-2xl font-bold">Course not found</h1>
        <Button onClick={() => router.push('/dashboard')} className="mt-4">
          Back to Dashboard
        </Button>
      </div>
    );
  }

  const prevStep = STEP_KEYS[STEP_KEYS.indexOf(currentStep) - 1] as StepId | undefined;
  const nextStep = STEP_KEYS[STEP_KEYS.indexOf(currentStep) + 1] as StepId | undefined;

  return (
    <div className="container mx-auto max-w-4xl px-4 pt-8 pb-14 sm:pb-8">
      <div className="mb-8">
        <Link
          href="/dashboard"
          className="mb-1 -ml-1 inline-flex min-h-11 items-center px-1 font-sans text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground hover:text-foreground"
        >
          ← Back to Dashboard
        </Link>
        <h1 className="text-3xl font-bold">{course.title}</h1>
        {course.description && (
          <p className="text-muted-foreground">{course.description}</p>
        )}
      </div>

      <StepIndicator
        steps={[...WIZARD_STEPS]}
        currentStep={currentStep}
        completedSteps={completedSteps}
        warningSteps={warningSteps}
        errorSteps={errorSteps}
      />

      <div className="bg-card border rounded-lg p-6">
        {currentStep === 'info' && (
          <WizardStep
            title="Course Information"
            description="What are you revising? Everything saves as you type."
          >
            <div className="space-y-4">
              <Input
                label="Course Title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={() => title.trim() && saveCourse({ title: title.trim() })}
                error={title.trim() ? undefined : 'Title is required'}
                placeholder="e.g., Introduction to Linear Algebra"
              />
              <Textarea
                label="Description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onBlur={() => saveCourse({ description })}
                rows={4}
              />
              <div className="grid gap-4 md:grid-cols-2">
                <Input
                  label="Subject Domain"
                  value={subjectDomain}
                  onChange={(e) => setSubjectDomain(e.target.value)}
                  onBlur={() => saveCourse({ subjectDomain })}
                  placeholder="e.g., mathematics, science, history"
                />
                <Input
                  label="Target Level"
                  value={targetLevel}
                  onChange={(e) => setTargetLevel(e.target.value)}
                  onBlur={() => saveCourse({ targetLevel })}
                  placeholder="e.g., introductory, intermediate, advanced"
                />
              </div>
              {saving && <Badge variant="info" dot>Saving…</Badge>}
            </div>
          </WizardStep>
        )}

        {currentStep === 'sources' && (
          <WizardStep
            title="Add your material"
            description="Notes, slides, chapters, past papers, a photo of a page. Or just type what the topic covers."
          >
            <FileUpload
              courseId={courseId}
              onSourcesChange={(next) => {
                setSources(next);
                // Tick the step as soon as there is material. It used to be
                // marked only inside restoreProgress, which runs on page load,
                // so "Your material" stayed unticked all the way to the end.
                if (next.length > 0) markCompleted('sources');
              }}
            />
            {sources.length > 0 && (
              <div className="mt-4 flex items-center gap-2">
                <Badge variant="success" dot>
                  {sources.length === 1 ? '1 thing added' : `${sources.length} things added`}
                </Badge>
                <p className="text-sm text-muted-foreground">
                  {alreadyBuilt
                    ? 'Update the course below, or carry on through the steps.'
                    : 'Next it reads all of this and tells you what it found.'}
                </p>
              </div>
            )}

            {/* Only meaningful once there is a course to update. */}
            {alreadyBuilt && (
              <Card className="mt-6">
                <CardContent className="pt-6">
                  <h3 className="font-display text-lg font-semibold">
                    Added something new?
                  </h3>
                  <p className="mt-2 max-w-[60ch] font-serif text-[1.0625rem] leading-relaxed text-foreground-soft">
                    Update this course with it. Anything you have already practised keeps its
                    progress, only genuinely new objectives get written, and the current version is
                    saved first so you can go back.
                  </p>
                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    <Button onClick={handleReplan} loading={replanning}>
                      Update this course
                    </Button>
                    {replanMessage && (
                      <span className="text-sm text-muted-foreground">{replanMessage}</span>
                    )}
                  </div>
                  {replanSummary && (
                    <p className="mt-3 text-sm font-medium text-primary">{replanSummary}</p>
                  )}
                </CardContent>
              </Card>
            )}
          </WizardStep>
        )}

        {currentStep === 'understanding' && (
          <WizardStep
            title="Check it read your material properly"
            description="This is what it thinks your material covers. Read it, and say yes if it looks right. Nothing gets written until you do."
          >
            {!knowledgePackage && !analyzing && (
              <Card>
                <CardContent className="pt-6 text-center">
                  <p className="text-muted-foreground mb-4">
                    {sources.length === 0
                      ? 'Add some material first, on the step before this one.'
                      : 'Read your material, so it knows what you are studying.'}
                  </p>
                  <Button onClick={handleAnalyze} disabled={sources.length === 0} loading={analyzing}>
                    {analysisError ? 'Try again' : 'Read my material'}
                  </Button>

                  {/* Rendered outside the `analyzing` guard on purpose: the guard
                      unmounts the moment the job settles, so an error shown there
                      would vanish before anyone could read it. */}
                  {analysisError && (
                    <div className="mx-auto mt-6 max-w-[52ch] rounded-lg border border-error/30 bg-error-subtle p-4 text-left">
                      <p className="text-sm font-semibold text-error-subtle-foreground">
                        It could not read your material.
                      </p>
                      <p className="mt-1.5 text-sm text-error-subtle-foreground">{analysisError}</p>
                      <div className="mt-4">
                        <Button variant="outline" size="sm" onClick={() => goToStep('sources')}>
                          Back to your material
                        </Button>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {analyzing && (
              <Card>
                <CardContent className="pt-6">
                  <div className="mb-2 h-2 w-full rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full bg-primary transition-all"
                      style={{ width: `${Math.round(analysisProgress * 100)}%` }}
                    />
                  </div>
                  <p className="text-sm text-muted-foreground">{analysisMessage}</p>
                </CardContent>
              </Card>
            )}

            {knowledgePackage && !analyzing && (
              <KnowledgePackageReview
                kp={knowledgePackage}
                fragments={fragments}
                editTitle={editTitle}
                editSubject={editSubject}
                editLevel={editLevel}
                editSummary={editSummary}
                setEditTitle={setEditTitle}
                setEditSubject={setEditSubject}
                setEditLevel={setEditLevel}
                setEditSummary={setEditSummary}
                onApprove={handleApprove}
                approving={approving}
                onReanalyze={handleAnalyze}
              />
            )}
          </WizardStep>
        )}

        {currentStep === 'preferences' && (
          <WizardStep
            title="How you want to be taught"
            description="Optional. Anything you say here changes how the lessons are written."
          >
            <Card>
              <CardHeader>
                <CardTitle className="text-base">What it thinks you are studying</CardTitle>
                <CardDescription>
                  {knowledgePackage
                    ? `${knowledgePackage.detectedSubject ?? knowledgePackage.analysis.subject ?? 'general'} · ${knowledgePackage.detectedLevel ?? knowledgePackage.analysis.level ?? 'introductory'}`
                    : subjectDomain || targetLevel || 'No interpretation approved yet'}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Textarea
                  label="Anything you want it to know"
                  value={preferencesNote}
                  onChange={(e) => setPreferencesNote(e.target.value)}
                  onBlur={handleSavePreferences}
                  rows={4}
                  placeholder="Go slowly on the hard parts, and use plenty of worked examples."
                  hint="Leave it blank if you have nothing to add."
                />
                {preferencesError && (
                  <p className="mt-3 text-sm font-medium text-error">{preferencesError}</p>
                )}
              </CardContent>
              <CardFooter>
                <Button onClick={handleSavePreferences} variant="outline" size="sm">
                  Save
                </Button>
              </CardFooter>
            </Card>
          </WizardStep>
        )}

        {currentStep === 'blueprint' && (
          <WizardStep
            title="The plan"
            description="The order it will teach things in, so nothing comes before what it depends on."
          >
            {!workspace || workspace.units.length === 0 ? (
              <Card>
                <CardContent className="pt-6 text-center">
                  <p className="text-muted-foreground mb-4">
                    Plan the course to see the units and objectives it will cover.
                  </p>
                  <Button onClick={handleGenerateBlueprint} loading={blueprinting} disabled={blueprinting}>
                    Plan the course
                  </Button>

                  {blueprintError && (
                    <div className="mx-auto mt-6 max-w-[52ch] rounded-lg border border-error/30 bg-error-subtle p-4 text-left">
                      <p className="text-sm font-semibold text-error-subtle-foreground">
                        It could not plan the course.
                      </p>
                      <p className="mt-1.5 text-sm text-error-subtle-foreground">{blueprintError}</p>
                      {/* Almost always the same cause, so say what to do about it. */}
                      <p className="mt-3 text-sm text-error-subtle-foreground">
                        This usually means the material has not been read and approved yet. Go back
                        to Sources, add what you are studying from, then approve what it found on
                        the next step.
                      </p>
                      <div className="mt-4">
                        <Button variant="outline" size="sm" onClick={() => goToStep('sources')}>
                          Back to Sources
                        </Button>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            ) : (
              <BlueprintReview workspace={workspace} />
            )}

            {blueprinting && (
              <div className="mt-4">
                <div className="mb-2 h-2 w-full rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{ width: `${Math.round(blueprintProgress * 100)}%` }}
                  />
                </div>
                <p className="text-sm text-muted-foreground">{blueprintMessage}</p>
              </div>
            )}
          </WizardStep>
        )}

        {currentStep === 'generation' && (
          <WizardStep
            title="Write it"
            description="Now it writes the lessons, the practice and the questions. This takes a few minutes."
          >
            <GenerationPipeline
              stage={generationStage}
              progress={generationProgress}
              message={generationMessage}
              generating={generating}
              onGenerate={handleGenerateCourse}
            />
          </WizardStep>
        )}

        {currentStep === 'qa' && (
          <WizardStep
            title="Marking"
            description="A second pass reads the course back and rewrites the weak parts. This is what it found."
          >
            <QaSummary workspace={workspace} warning={qaWarning} courseId={courseId} />
          </WizardStep>
        )}

        {currentStep === 'workspace' && (
          <WizardStep
            title="Course Workspace"
            description="Open the full workspace to review and edit your completed course."
          >
            <Card>
              <CardContent className="pt-6 text-center">
                <p className="text-muted-foreground mb-4">
                  Your course is ready. Open the workspace to review lessons, practice, and assessments.
                </p>
                <Link href={`/workspace/${courseId}`}>
                  <Button>Open Workspace</Button>
                </Link>
              </CardContent>
            </Card>
          </WizardStep>
        )}
      </div>

      {/*
        Phone: Back/Next ride at the bottom of the screen — above the tab bar
        and the home indicator — so changing step never means scrolling a long
        form to the end. On anything wider they sit inline as before.
      */}
      <div
        className={cn(
          'fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-30 border-t border-border bg-card/95 px-4 py-3 backdrop-blur-md',
          'sm:static sm:mt-6 sm:border-t-0 sm:bg-transparent sm:px-0 sm:py-0 sm:backdrop-blur-none',
        )}
      >
        <div className="mx-auto flex max-w-4xl gap-3">
          <Button
            variant="outline"
            className="min-h-11 flex-1 sm:flex-none"
            onClick={() => prevStep && goToStep(prevStep)}
            disabled={!prevStep}
          >
            ← Previous
          </Button>
          <Button
            className="min-h-11 flex-1 sm:ml-auto sm:flex-none"
            onClick={() => nextStep && goToStep(nextStep)}
            disabled={!nextStep}
          >
            Next →
          </Button>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------- subcomponents ---- */

function KnowledgePackageReview(props: {
  kp: KnowledgePackage;
  fragments: SourceFragment[];
  editTitle: string;
  editSubject: string;
  editLevel: string;
  editSummary: string;
  setEditTitle: (v: string) => void;
  setEditSubject: (v: string) => void;
  setEditLevel: (v: string) => void;
  setEditSummary: (v: string) => void;
  onApprove: () => void;
  approving: boolean;
  onReanalyze: () => void;
}) {
  const {
    kp,
    fragments,
    editTitle,
    editSubject,
    editLevel,
    editSummary,
    setEditTitle,
    setEditSubject,
    setEditLevel,
    setEditSummary,
    onApprove,
    approving,
    onReanalyze,
  } = props;

  const a = kp.analysis;
  const isApproved = kp.status === 'approved';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Detected interpretation</h3>
        {isApproved ? (
          <Badge variant="success" dot>
            Approved
          </Badge>
        ) : (
          <Badge variant="warning" dot>
            Draft
          </Badge>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Input label="Title" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
        <Input label="Subject" value={editSubject} onChange={(e) => setEditSubject(e.target.value)} />
        <Input label="Level" value={editLevel} onChange={(e) => setEditLevel(e.target.value)} />
        <Input
          label="Confidence"
          value={`${Math.round((a.confidence ?? 0) * 100)}%`}
          disabled
        />
      </div>

      <Textarea
        label="Summary"
        value={editSummary}
        onChange={(e) => setEditSummary(e.target.value)}
        rows={4}
      />

      {a.objectives.length > 0 && (
        <div>
          <h4 className="text-sm font-medium mb-2">Learning objectives ({a.objectives.length})</h4>
          <ul className="space-y-1 text-sm text-muted-foreground">
            {a.objectives.map((o, i) => (
              <li key={i} className="flex items-start gap-2">
                <Badge variant="secondary">{o.classification ?? 'skill'}</Badge>
                <span>{o.statement}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {a.units.length > 0 && (
        <div>
          <h4 className="text-sm font-medium mb-2">Units ({a.units.length})</h4>
          <ul className="space-y-1 text-sm text-muted-foreground">
            {a.units.map((u) => (
              <li key={u.ordinal}>{u.ordinal + 1}. {u.title}</li>
            ))}
          </ul>
        </div>
      )}

      {a.terminology.length > 0 && (
        <div>
          <h4 className="text-sm font-medium mb-2">Terminology ({a.terminology.length})</h4>
          <div className="flex flex-wrap gap-2">
            {a.terminology.map((t, i) => (
              <Badge key={i} variant="outline">
                {t.term}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {a.requirements.length > 0 && (
        <div>
          <h4 className="text-sm font-medium mb-2">Requirements</h4>
          <ul className="list-disc pl-5 text-sm text-muted-foreground space-y-1">
            {a.requirements.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      {a.ambiguities.length > 0 && (
        <div>
          <h4 className="text-sm font-medium mb-2">Ambiguities ({a.ambiguities.length})</h4>
          <ul className="space-y-2">
            {a.ambiguities.map((amb) => (
              <li key={amb.id} className="rounded-md border p-3 text-sm">
                <div className="flex items-center gap-2">
                  <Badge variant="warning" dot>
                    {Math.round(amb.confidence * 100)}%
                  </Badge>
                  <span>{amb.description}</span>
                </div>
                {amb.suggestion && (
                  <p className="mt-1 text-xs text-muted-foreground">Suggestion: {amb.suggestion}</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {fragments.length > 0 && (
        <div>
          <h4 className="text-sm font-medium mb-2">Source fragments ({fragments.length})</h4>
          <div className="max-h-64 overflow-y-auto space-y-2">
            {fragments.map((f) => (
              <div key={f.id} className="rounded-md border p-3 text-xs text-muted-foreground">
                <div className="flex items-center gap-2 mb-1">
                  <Badge variant="secondary">{f.kind}</Badge>
                  {f.page != null && <span>p. {f.page}</span>}
                  {f.uncertain ? <Badge variant="warning">uncertain</Badge> : null}
                </div>
                <p className="line-clamp-3">{f.text}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Nothing downstream works until this is approved, and the failure it
          causes is three steps away, so say so before it happens. */}
      <div className="mt-6 rounded-lg border border-border bg-secondary/50 p-4">
        <p className="text-sm font-semibold">Does that match your material?</p>
        <p className="mt-1 max-w-[60ch] text-sm text-muted-foreground">
          {isApproved
            ? 'Approved. You can carry on to the plan.'
            : 'Say yes and it starts building the course. If it has missed something or got it wrong, read it again after adding more material. Nothing is written until you approve.'}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button onClick={onApprove} loading={approving} disabled={isApproved}>
            {isApproved ? 'Approved' : 'Yes, that is my material'}
          </Button>
          <Button onClick={onReanalyze} variant="outline" disabled={approving}>
            Read it again
          </Button>
        </div>
      </div>
    </div>
  );
}

function BlueprintReview(props: { workspace: WorkspaceData }) {
  const { workspace } = props;
  const objectivesByUnit = new Map<string, ObjectiveEntity[]>();
  for (const o of workspace.objectives) {
    const key = o.unitId ?? 'unassigned';
    const arr = objectivesByUnit.get(key) ?? [];
    arr.push(o);
    objectivesByUnit.set(key, arr);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Badge variant="success" dot>
          {workspace.units.length} units
        </Badge>
        <Badge variant="info" dot>
          {workspace.objectives.length} objectives
        </Badge>
      </div>
      <div className="space-y-4">
        {workspace.units.map((u) => {
          const objs = objectivesByUnit.get(u.id) ?? [];
          return (
            <Card key={u.id}>
              <CardHeader>
                <CardTitle className="text-base">
                  Unit {u.ordinal + 1}: {unitDisplayTitle(u.title)}
                </CardTitle>
                {u.description && (
                  <CardDescription>{u.description}</CardDescription>
                )}
                {/* Wrapped: CardHeader is a stretch column, so a bare badge
                    stretched the full width of the card and read as a broken
                    progress bar. */}
                <div>
                  <Badge variant="outline">{u.classification}</Badge>
                </div>
              </CardHeader>
              <CardContent>
                {objs.length > 0 ? (
                  <ul className="space-y-2">
                    {objs.map((o) => (
                      <li key={o.id} className="text-sm">
                        <div className="flex items-center gap-2">
                          {o.code && <Badge variant="secondary">{o.code}</Badge>}
                          <span className="font-medium">{o.title}</span>
                        </div>
                        <p className="text-muted-foreground">{o.statement}</p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">No objectives assigned to this unit.</p>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function GenerationPipeline(props: {
  stage: string;
  progress: number;
  message: string;
  generating: boolean;
  onGenerate: () => void;
}) {
  const { stage, progress, message, generating, onGenerate } = props;

  const activeIndex = GENERATION_PIPELINE.findIndex((s) => s.stage === stage);
  const hasStarted = stage !== '' || generating;
  const isComplete = stage === 'complete';

  if (!hasStarted && !generating) {
    return (
      <Card>
        <CardContent className="pt-6 text-center">
          <p className="text-muted-foreground mb-4">
            This writes a lesson, practice questions and a test for everything in the plan.
          </p>
          <Button onClick={onGenerate} loading={generating}>
            Write the course
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="mb-2 h-2 w-full rounded-full bg-muted overflow-hidden">
        <div
          className="h-full bg-primary transition-all"
          // Once the pipeline says it is done the bar is full, whatever the
          // last progress number happened to be. It used to read "Generation
          // complete" over a bar about a fifth of the way along.
          style={{ width: `${isComplete ? 100 : Math.round(progress * 100)}%` }}
        />
      </div>
      <ol className="space-y-3">
        {GENERATION_PIPELINE.map((s, i) => {
          const isDone = isComplete || (activeIndex >= 0 && i < activeIndex);
          const isActive = !isComplete && i === activeIndex;

          return (
            <li key={s.stage} className="flex items-center gap-3">
              <div
                className={[
                  'flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium',
                  isDone
                    ? 'bg-primary text-primary-foreground'
                    : isActive
                    ? 'bg-primary text-primary-foreground animate-pulse'
                    : 'bg-muted text-muted-foreground',
                ].join(' ')}
              >
                {isDone ? (
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                ) : isActive ? (
                  <span className="animate-spin">↻</span>
                ) : (
                  i + 1
                )}
              </div>
              <span
                className={[
                  'text-sm font-medium',
                  isDone || isActive ? 'text-foreground' : 'text-muted-foreground',
                ].join(' ')}
              >
                {s.label}
              </span>
              {isActive && <Badge variant="info" dot>{message}</Badge>}
            </li>
          );
        })}
      </ol>
      {!generating && stage === 'complete' && (
        <p className="text-sm text-muted-foreground">All written.</p>
      )}
    </div>
  );
}

function QaSummary(props: { workspace: WorkspaceData | null; warning: boolean; courseId: string }) {
  const { workspace, warning, courseId } = props;

  const counts = {
    units: workspace?.units.length ?? 0,
    objectives: workspace?.objectives.length ?? 0,
    lessons: workspace?.lessons.length ?? 0,
    assessments: workspace?.assessments.length ?? 0,
    questions: workspace?.questions.length ?? 0,
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        {warning ? (
          <Badge variant="warning" dot>
            Remaining issues
          </Badge>
        ) : (
          <Badge variant="success" dot>
            QA passed
          </Badge>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3">
        <Card>
          <CardContent className="pt-6 text-center">
            <p className="text-3xl font-bold">{counts.units}</p>
            <p className="text-sm text-muted-foreground">Units</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6 text-center">
            <p className="text-3xl font-bold">{counts.objectives}</p>
            <p className="text-sm text-muted-foreground">Objectives</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6 text-center">
            <p className="text-3xl font-bold">{counts.lessons}</p>
            <p className="text-sm text-muted-foreground">Lessons</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6 text-center">
            <p className="text-3xl font-bold">{counts.assessments}</p>
            <p className="text-sm text-muted-foreground">Assessments</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6 text-center">
            <p className="text-3xl font-bold">{counts.questions}</p>
            <p className="text-sm text-muted-foreground">Questions</p>
          </CardContent>
        </Card>
      </div>

      {warning && (
        <p className="text-sm text-muted-foreground">
          QA reported remaining issues. Review them in the workspace.
        </p>
      )}
      <Link href={`/workspace/${courseId}`}>
        <Button variant="outline">Review in Workspace</Button>
      </Link>
    </div>
  );
}