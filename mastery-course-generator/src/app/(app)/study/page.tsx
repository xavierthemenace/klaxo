'use client';

/**
 * Study — the front door.
 *
 * This app is for revising, so it opens on what to revise rather than on a
 * list of things you have built. Per set of material: how close it is to
 * ready, what is due for review, and what is weakest, with one button that
 * starts practice on it.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';

interface Course {
  id: string;
  title: string;
  status: string;
  stage: string;
  updatedAt: number;
}

interface MasteryRecord {
  objectiveId: string;
  objectiveStatement?: string;
  state: string;
}

interface CourseStudy {
  course: Course;
  total: number;
  mastered: number;
  due: number;
  weak: { id: string; statement: string }[];
  /** Has questions to answer. Objectives alone are not something to revise. */
  ready: boolean;
}

const MASTERED_STATES = new Set(['MASTERED', 'PROVISIONAL']);
const WEAK_STATES = new Set(['NEEDS_REVIEW', 'PRACTICING', 'INTRODUCED']);

export default function StudyPage() {
  const [items, setItems] = useState<CourseStudy[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch('/api/courses');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? 'Could not load your material.');

        const courses: Course[] = data.courses ?? [];

        // Mastery is per course, so the summary has to be assembled here.
        // These run together rather than in sequence; there are only ever a
        // handful of courses.
        const studies = await Promise.all(
          courses.map(async (course): Promise<CourseStudy> => {
            const empty = { course, total: 0, mastered: 0, due: 0, weak: [], ready: false };
            try {
              const [masteryRes, workspaceRes] = await Promise.all([
                fetch(`/api/courses/${course.id}/mastery`),
                fetch(`/api/courses/${course.id}/workspace`),
              ]);
              if (!masteryRes.ok) return empty;
              const mastery = await masteryRes.json();

              // "Ready" has to mean there is something to answer. Judging it on
              // objectives alone sent people to an empty practice screen with
              // no way forward.
              const workspace = workspaceRes.ok ? await workspaceRes.json() : null;
              const questionCount: number = (workspace?.questions ?? []).length;

              const records: MasteryRecord[] = mastery.records ?? [];
              const due = (mastery.recommendations?.cumulativeReview ?? []).length;

              const objectiveCount: number = mastery.objectiveCount ?? 0;

              return {
                course,
                total: objectiveCount,
                mastered: records.filter((r) => MASTERED_STATES.has(r.state)).length,
                due,
                weak: records
                  .filter((r) => WEAK_STATES.has(r.state))
                  .slice(0, 3)
                  .map((r) => ({
                    id: r.objectiveId,
                    statement: r.objectiveStatement ?? 'Untitled objective',
                  })),
                ready: questionCount > 0,
              };
            } catch {
              return empty;
            }
          }),
        );

        if (cancelled) return;

        // What is due comes first, then what is weakest, then everything else.
        studies.sort((a, b) => b.due - a.due || b.weak.length - a.weak.length);
        setItems(studies);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Something went wrong.');
        setItems([]);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (items === null) {
    return (
      <div className="grid gap-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  return (
    <div className="grid gap-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">Study</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-[-0.03em] sm:text-4xl">
            What to work on.
          </h1>
          <p className="mt-2 max-w-[54ch] font-serif text-[1.0625rem] leading-relaxed text-foreground-soft">
            Ordered by what is due for review, then by what you are weakest on.
          </p>
        </div>
        {items.length > 0 && (
          <Link href="/dashboard">
            <Button variant="outline">Add material</Button>
          </Link>
        )}
      </header>

      {error && (
        <p className="text-sm text-error" role="alert">
          {error}
        </p>
      )}

      {items.length === 0 && !error && (
        <Card>
          <CardContent className="p-8 text-center">
            <h2 className="font-display text-xl font-semibold">Nothing to revise yet</h2>
            <p className="mx-auto mt-2 max-w-[46ch] font-serif text-[1.0625rem] leading-relaxed text-foreground-soft">
              Add the notes, slides or chapters you are studying from, and KLAXO turns them into
              practice you can actually drill.
            </p>
            <Link href="/dashboard" className="mt-6 inline-block">
              <Button size="lg">Add material</Button>
            </Link>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4">
        {items.map((item) => (
          <StudyCard key={item.course.id} item={item} />
        ))}
      </div>
    </div>
  );
}

function StudyCard({ item }: { item: CourseStudy }) {
  const { course, total, mastered, due, weak, ready } = item;
  const percent = total > 0 ? Math.round((mastered / total) * 100) : 0;

  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="font-display text-xl font-semibold tracking-[-0.02em]">{course.title}</h2>
            {ready ? (
              <p className="mt-1 text-sm text-muted-foreground">
                <span className="tabular-nums">{mastered}</span> of{' '}
                <span className="tabular-nums">{total}</span> objectives solid
                {due > 0 && (
                  <>
                    {' · '}
                    <span className="font-semibold text-primary">
                      <span className="tabular-nums">{due}</span> due for review
                    </span>
                  </>
                )}
              </p>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">
                Not finished yet. Practice appears here once it has questions.
              </p>
            )}
          </div>

          <div className="flex flex-wrap gap-2.5">
            {ready ? (
              <>
                {/* Real links, styled as buttons, so they can be opened in a
                    new tab like any other link on the page. */}
                <Link href={`/workspace/${course.id}?tab=practice`} className={buttonClasses()}>
                  Practice
                </Link>
                <Link
                  href={`/workspace/${course.id}?tab=mastery`}
                  className={buttonClasses('outline')}
                >
                  Progress
                </Link>
              </>
            ) : (
              <Link href={`/wizard/${course.id}`}>
                <Button>Keep building</Button>
              </Link>
            )}
          </div>
        </div>

        {ready && (
          <>
            <div className="mt-5 h-2 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-500"
                style={{ width: `${percent}%` }}
              />
            </div>

            {weak.length > 0 && (
              <div className="mt-5 border-t border-hairline pt-4">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  Weakest right now
                </p>
                <ul className="mt-2.5 grid gap-2">
                  {weak.map((objective) => (
                    <li key={objective.id} className="flex gap-2.5 text-sm">
                      <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                      <span className="text-foreground-soft">{objective.statement}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
