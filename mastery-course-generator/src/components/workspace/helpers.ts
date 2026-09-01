/**
 * Pure client-side helpers shared across workspace components: safe JSON
 * parsing for the open-ended JSON text columns, and small display utilities.
 */

import type {
  AnswerKey,
  Choice,
  LessonContent,
  MasteryState,
  RecommendationAction,
} from './types';
import type { BadgeVariant } from '@/components/ui/Badge';

/** Safely parse a JSON column that may already be an object/array or null. */
export function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw == null) return fallback;
  if (typeof raw !== 'string') return raw as unknown as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function parseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return parseJson<string[]>(raw, []);
}

export function parseLessonContent(raw: string | null | undefined): LessonContent {
  if (!raw) return { sections: [], misconceptions: [], objectives: [], summary: '' };
  return parseJson<LessonContent>(raw, {
    sections: [],
    misconceptions: [],
    objectives: [],
    summary: '',
  });
}

export function parseChoices(raw: string | null | undefined): Choice[] {
  if (!raw) return [];
  return parseJson<Choice[]>(raw, []);
}

export function parseAnswerKey(raw: string | null | undefined): AnswerKey {
  if (!raw) return {};
  return parseJson<AnswerKey>(raw, {});
}

/** Map a mastery state to a Badge variant + a friendly label. */
export const MASTERY_STATE_META: Record<MasteryState, { label: string; variant: BadgeVariant }> = {
  NOT_STARTED: { label: 'Not started', variant: 'secondary' },
  INTRODUCED: { label: 'Introduced', variant: 'info' },
  PRACTICING: { label: 'Practicing', variant: 'info' },
  PROVISIONAL: { label: 'Provisional', variant: 'warning' },
  MASTERED: { label: 'Mastered', variant: 'success' },
  NEEDS_REVIEW: { label: 'Needs review', variant: 'error' },
};

export function masteryVariant(state: MasteryState): BadgeVariant {
  return MASTERY_STATE_META[state]?.variant ?? 'secondary';
}

export function masteryLabel(state: MasteryState): string {
  return MASTERY_STATE_META[state]?.label ?? state;
}

export function recommendationLabel(action: RecommendationAction): string {
  switch (action) {
    case 'remediate':
      return 'Go back over this one';
    case 'more_practice':
      return 'Keep practising this';
    case 'advance':
      return 'Move on to something new';
    case 'challenge':
      return 'Try a harder one';
    case 'cumulative_review':
      return 'Come back to this later';
    case 'introduce':
      return 'Start on this one';
    default:
      return action;
  }
}

/** Map a difficulty/importance integer (1–5) to a compact label. */
export function levelLabel(value: number): string {
  switch (value) {
    case 1:
      return 'Very easy';
    case 2:
      return 'Easy';
    case 3:
      return 'Moderate';
    case 4:
      return 'Hard';
    default:
      return 'Very hard';
  }
}

/** Format an epoch-ms timestamp into a local date/time string. */
export function formatDate(ts: number | null | undefined): string {
  if (ts == null || !Number.isFinite(ts)) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** A short relative "time until review is due" helper. */
export function relativeDays(ts: number | null | undefined): string {
  if (ts == null || !Number.isFinite(ts)) return 'Not scheduled';
  const days = Math.round((ts - Date.now()) / (24 * 60 * 60 * 1000));
  if (days <= 0) return 'Due now';
  if (days === 1) return 'Due tomorrow';
  return `Due in ${days} days`;
}

/** Humanize a question kind. "mcq" is not a word anyone outside the code uses. */
const KIND_LABELS: Record<string, string> = {
  mcq: 'Multiple choice',
  short_answer: 'Short answer',
  numeric: 'Number',
  code: 'Code',
};

export function humanizeKind(kind: string): string {
  return (
    KIND_LABELS[kind] ??
    kind.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

/**
 * Strip a leading "Unit N:" prefix from a unit title so callers can prepend
 * their own numbering without doubling it ("Unit 1: Unit 1: Foundations").
 */
export function unitDisplayTitle(title: string): string {
  return title.replace(/^unit\s*\d+\s*[:.\-–]\s*/i, '');
}

/**
 * Plain-English label for a lesson's stored status.
 *
 * The raw values ('generated', 'regenerated') were being printed straight onto
 * the screen under each lesson title.
 */
export function lessonStatusLabel(status: string | null | undefined): string {
  switch (status) {
    case 'generated':
      return 'Written';
    case 'regenerated':
      return 'Rewritten after marking';
    case 'edited':
      return 'Edited by you';
    case 'draft':
      return 'Draft';
    default:
      return status ? 'Written' : '';
  }
}
