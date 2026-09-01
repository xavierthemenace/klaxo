'use client';

/**
 * Interactive question renderer shared by the Practice and Assessments tabs.
 * Supports MCQ (choice buttons), short_answer/numeric (text input), and
 * matching/ordering (basic). On submit it POSTs to the practice/attempt API and
 * surfaces correctness, explanation, updated mastery state, and the next action.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { cn } from '@/lib/cn';
import type { AttemptResult, Question } from './types';
import {
  humanizeKind,
  levelLabel,
  masteryLabel,
  masteryVariant,
  parseAnswerKey,
  parseChoices,
  recommendationLabel,
} from './helpers';

export interface QuestionCardProps {
  question: Question;
  courseId: string;
  /** Resolve the objective statement for display, if known. */
  objectiveStatement?: string | null;
  /**
   * Called after an answer is recorded, so the page can refresh whatever it
   * showed about mastery. Without it the Mastery tab kept saying "no activity"
   * immediately after answering, and only a reload fixed it.
   */
  onAnswered?: () => void;
  /**
   * The last answer recorded for this question, if there is one. Reloading the
   * page used to bring a question back completely blank, with nothing to say
   * it had already been answered.
   */
  previousAttempt?: PreviousAttempt | null;
}

/** The shape the workspace API returns for a recorded attempt. */
export interface PreviousAttempt {
  isCorrect: number;
  score: number;
  createdAt: number;
}

type Feedback = {
  isCorrect: boolean;
  result: AttemptResult;
} | null;

/** The learner-facing answer payload for each supported kind. */
type ResponseShape = string | number | string[] | Record<string, unknown>;

export default function QuestionCard({
  question,
  courseId,
  objectiveStatement,
  onAnswered,
  previousAttempt,
}: QuestionCardProps) {
  const choices = useMemo(() => parseChoices(question.choices), [question.choices]);
  const answerKey = useMemo(() => parseAnswerKey(question.answerKey), [question.answerKey]);

  // Input state per question kind.
  const [mcqSelection, setMcqSelection] = useState<string | null>(null);
  const [textValue, setTextValue] = useState('');
  const [orderValues, setOrderValues] = useState<string[]>([]);

  const [feedback, setFeedback] = useState<Feedback>(null);
  const [submitting, setSubmitting] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);

  const startedAtRef = useRef<number | null>(null);

  const isMcq = question.kind === 'mcq';
  const isNumeric = question.kind === 'numeric';
  const isShortAnswer = question.kind === 'short_answer';
  const isOrdering = question.kind === 'ordering';
  const isMatching = question.kind === 'matching';
  const isTextInput = isNumeric || isShortAnswer || question.kind === 'proof' ||
    question.kind === 'code' || question.kind === 'essay';

  /** Build the ordering/matching choices from the answer key when choices are absent. */
  const orderingItems = useMemo(() => {
    if (!isOrdering && !isMatching) return [];
    if (choices.length > 0) return choices.map((c) => c.text ?? c.id ?? '').filter(Boolean);
    const seq = Array.isArray(answerKey.sequence)
      ? answerKey.sequence.map(String)
      : Array.isArray(answerKey.pairs)
        ? answerKey.pairs.flatMap((p) => (Array.isArray(p) ? p.map(String) : [String(p)]))
        : [];
    return seq;
  }, [isOrdering, isMatching, choices, answerKey]);

  /** Initialize ordering values once items are known. */
  const orderReady = orderValues.length === orderingItems.length && orderingItems.length > 0;

  const buildResponse = useCallback((): ResponseShape => {
    if (isMcq || isOrdering || isMatching) {
      if (isOrdering && orderValues.length > 0) return orderValues;
      if (isMatching && orderValues.length > 0) return orderValues;
      return mcqSelection ?? '';
    }
    if (isNumeric) return Number(textValue);
    return textValue;
  }, [isMcq, isOrdering, isMatching, isNumeric, mcqSelection, textValue, orderValues]);

  const canSubmit = useCallback(() => {
    if (isMcq) return mcqSelection != null;
    if (isOrdering || isMatching) {
      return orderReady || (orderValues.length > 0 && orderingItems.length === 0);
    }
    return textValue.trim().length > 0;
  }, [isMcq, isOrdering, isMatching, orderReady, orderValues, orderingItems.length, mcqSelection, textValue]);

  const resetForKind = useCallback(() => {
    setFeedback(null);
    setRequestError(null);
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit() || submitting || feedback) return;
    const response = buildResponse();
    const durationMs = startedAtRef.current != null ? Date.now() - startedAtRef.current : undefined;

    setSubmitting(true);
    setRequestError(null);
    try {
      const res = await fetch(`/api/courses/${courseId}/practice/attempt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          questionId: question.id,
          objectiveId: question.objectiveId,
          response,
          durationMs,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRequestError(data?.error ?? 'Failed to submit attempt');
        return;
      }
      const isCorrect = Boolean(data.attempt?.isCorrect);
      setFeedback({ isCorrect, result: data as AttemptResult });
      onAnswered?.();
    } catch (err) {
      setRequestError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, submitting, feedback, buildResponse, courseId, question.id, question.objectiveId, onAnswered]);

  const toggleOrder = useCallback((item: string) => {
    setFeedback(null);
    setOrderValues((prev) => {
      if (prev.includes(item)) return prev.filter((x) => x !== item);
      return [...prev, item];
    });
  }, []);

  return (
    <div
      className="rounded-lg border bg-card p-4 shadow-sm"
      onFocus={() => {
        if (startedAtRef.current == null) startedAtRef.current = Date.now();
      }}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Badge variant="outline">{humanizeKind(question.kind)}</Badge>
        {question.difficulty != null && (
          <Badge variant="secondary">{levelLabel(question.difficulty)}</Badge>
        )}
        {question.expectedSkill && (
          <Badge variant="info" dot>
            {question.expectedSkill}
          </Badge>
        )}
      </div>

      <p className="mb-3 text-sm font-medium text-foreground">{question.prompt}</p>

      {objectiveStatement && (
        <p className="mb-3 text-xs text-muted-foreground">
          This tests: <span className="font-medium">{objectiveStatement}</span>
        </p>
      )}

      {/* MCQ */}
      {isMcq && (
        <div className="mb-3 grid gap-2">
          {choices.map((choice, idx) => {
            const label = choice.id ?? choice.text ?? String(idx);
            const active = mcqSelection === label;
            return (
              <button
                key={label + idx}
                type="button"
                disabled={Boolean(feedback)}
                onClick={() => {
                  setMcqSelection(active ? null : label);
                  resetForKind();
                }}
                className={cn(
                  // The most-tapped control in the app, so it clears 44px on a phone.
                  'flex min-h-11 items-start gap-2 rounded-md border px-3 py-2.5 text-left text-sm transition-colors sm:min-h-0 sm:py-2',
                  active
                    ? 'border-primary bg-primary/5 text-foreground'
                    : 'border-border hover:border-primary/40 hover:bg-accent',
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold',
                    active ? 'border-primary text-primary' : 'border-muted-foreground/40 text-muted-foreground',
                  )}
                >
                  {String.fromCharCode(65 + idx)}
                </span>
                <span>{choice.text}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Short answer / numeric / code / essay */}
      {isTextInput && (
        <div className="mb-3">
          <Input
            type={isNumeric ? 'number' : 'text'}
            step={isNumeric ? 'any' : undefined}
            value={textValue}
            onChange={(e) => {
              setTextValue(e.target.value);
              resetForKind();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canSubmit()) void handleSubmit();
            }}
            placeholder={isNumeric ? 'Enter a number' : 'Type your answer'}
          />
        </div>
      )}

      {/* Ordering / matching (basic tap-to-order) */}
      {(isOrdering || isMatching) && (
        <div className="mb-3">
          <div className="mb-2 text-xs text-muted-foreground">
            {isOrdering
              ? 'Tap items in the correct order.'
              : 'Tap items to build your pairing sequence.'}
          </div>
          <div className="mb-2 flex flex-wrap gap-2">
            {orderingItems.map((item) => {
              const pos = orderValues.indexOf(item);
              const selected = pos >= 0;
              return (
                <button
                  key={item}
                  type="button"
                  onClick={() => toggleOrder(item)}
                  className={cn(
                    'min-h-11 rounded-md border px-3 py-1.5 text-xs transition-colors sm:min-h-0',
                    selected
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-border hover:border-primary/40',
                  )}
                >
                  {selected ? `${pos + 1}. ${item}` : item}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Unsupported / default fallback still allows a text attempt for ungraded kinds. */}
      {!isMcq && !isTextInput && !isOrdering && !isMatching && (
        <div className="mb-3">
          <Input
            type="text"
            value={textValue}
            onChange={(e) => {
              setTextValue(e.target.value);
              resetForKind();
            }}
            placeholder="Type your answer"
          />
        </div>
      )}

      {previousAttempt && !feedback && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-secondary/60 p-3">
          <Badge variant={previousAttempt.isCorrect ? 'success' : 'error'}>
            {previousAttempt.isCorrect ? 'You got this right' : 'You got this wrong'}
          </Badge>
          <span className="text-sm text-muted-foreground">
            Answer it again to have another go.
          </span>
        </div>
      )}

      <div className="flex items-center gap-3">
        <Button
          onClick={() => void handleSubmit()}
          loading={submitting}
          disabled={!canSubmit() || Boolean(feedback)}
          className="min-h-11 sm:min-h-9"
          size="sm"
        >
          {feedback ? 'Answered' : 'Submit'}
        </Button>
        {requestError && <span className="text-sm text-error">{requestError}</span>}
      </div>

      {/* Feedback panel */}
      {feedback && (
        <div
          className={cn(
            'mt-4 rounded-md border p-3 text-sm',
            feedback.isCorrect
              ? 'border-success/30 bg-success-subtle'
              : 'border-error/30 bg-error-subtle',
          )}
        >
          <div className="mb-1 flex items-center gap-2 font-medium">
            <Badge variant={feedback.isCorrect ? 'success' : 'error'}>
              {feedback.isCorrect ? 'Correct' : 'Incorrect'}
            </Badge>
            <span className="text-xs text-muted-foreground">
              Score {Math.round(feedback.result.attempt.score * 100)}%
            </span>
          </div>

          {feedback.result.attempt.misconceptionTag && (
            <p className="mb-1 text-xs">
              <span className="font-medium">Looks like you thought:</span>{' '}
              {feedback.result.attempt.misconceptionTag}
            </p>
          )}

          {question.explanation && (
            <p className="mb-2 leading-relaxed">{question.explanation}</p>
          )}

          <div className="mt-2 border-t border-border/50 pt-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">Where you are on this:</span>
              <Badge variant={masteryVariant(feedback.result.mastery.state)} dot>
                {masteryLabel(feedback.result.mastery.state)}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {feedback.result.mastery.correctCount}/{feedback.result.mastery.attemptCount} correct ·{' '}
                streak {feedback.result.mastery.streak}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Next: <span className="font-medium text-foreground">{recommendationLabel(feedback.result.recommendation)}</span>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}