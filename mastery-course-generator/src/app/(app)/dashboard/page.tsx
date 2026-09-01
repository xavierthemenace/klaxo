'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';

interface Course {
  id: string;
  title: string;
  description: string | null;
  subjectDomain: string | null;
  targetLevel: string | null;
  status: string;
  stage: string;
  updatedAt: number;
  objectiveCount?: number;
  questionCount?: number;
}

type SortOrder = 'updated-desc' | 'updated-asc' | 'title';

/**
 * What state is this course actually in?
 *
 * The database has a status column, but nothing ever changes it: every course
 * read "DRAFT / CREATED" forever, including finished ones. What matters to
 * someone looking at the list is whether there is practice waiting, so the
 * label is worked out from what the course contains.
 */
function courseState(course: Course): {
  label: string;
  variant: 'success' | 'warning' | 'info' | 'error' | 'default';
} {
  const questions = course.questionCount ?? 0;
  const objectives = course.objectiveCount ?? 0;
  if (questions > 0) return { label: 'Ready to practise', variant: 'success' };
  if (objectives > 0) return { label: 'Being written', variant: 'info' };
  return { label: 'Not built yet', variant: 'default' };
}

function formatRelative(date: number): string {
  const diff = Date.now() - date;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(date).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function labelize(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
}

function CourseCardSkeleton() {
  return (
    <Card>
      <CardContent className="flex flex-col gap-4 p-6">
        <div className="flex items-start justify-between gap-3">
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-5 w-20 rounded-full" />
        </div>
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
        <div className="flex gap-2">
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-5 w-20 rounded-full" />
        </div>
        <div className="mt-1 flex gap-3">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-24" />
        </div>
      </CardContent>
    </Card>
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const [courses, setCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [naming, setNaming] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  /** Course awaiting a second tap before it is deleted. */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortOrder>('updated-desc');

  const loadCourses = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/courses');
      if (!res.ok) {
        throw new Error(`Request failed with status ${res.status}`);
      }
      const data = await res.json();
      setCourses(Array.isArray(data.courses) ? data.courses : []);
    } catch (err) {
      console.error('Failed to load courses:', err);
      setError('We could not load your courses. Please try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/courses')
      .then((res) => {
        if (cancelled) return undefined;
        if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (cancelled || !data) return;
        setCourses(Array.isArray(data.courses) ? data.courses : []);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.error('Failed to load courses:', err);
        setError('We could not load your courses. Please try again.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Create a course, named.
   *
   * Pressing the button used to save an "Untitled Course" immediately, so
   * backing out of the builder left a row behind with no name on it. Nothing
   * is written until there is a subject to write down.
   */
  const createCourse = useCallback(async () => {
    const title = newTitle.trim();
    if (!title) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch('/api/courses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          subjectDomain: null,
          targetLevel: null,
        }),
      });
      if (!res.ok) {
        throw new Error(`Create failed with status ${res.status}`);
      }
      const data = await res.json();
      router.push(`/wizard/${data.course.id}`);
    } catch (err) {
      console.error('Failed to create course:', err);
      setError('We could not create the course. Please try again.');
      setCreating(false);
    }
  }, [router, newTitle]);

  const handleDelete = useCallback(async (courseId: string) => {
    setDeletingId(courseId);
    setError(null);
    try {
      const res = await fetch(`/api/courses/${courseId}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `Delete failed with status ${res.status}`);
      }
      setCourses((prev) => prev.filter((c) => c.id !== courseId));
      setPendingDelete(null);
    } catch (err) {
      console.error('Failed to delete course:', err);
      setError('We could not delete that course. Please try again.');
    } finally {
      setDeletingId(null);
    }
  }, []);

  const filteredCourses = useMemo(() => {
    const query = search.trim().toLowerCase();
    const result = query
      ? courses.filter(
          (c) =>
            c.title.toLowerCase().includes(query) ||
            (c.description ?? '').toLowerCase().includes(query) ||
            (c.subjectDomain ?? '').toLowerCase().includes(query),
        )
      : [...courses];

    result.sort((a, b) => {
      if (sort === 'title') {
        return a.title.localeCompare(b.title);
      }
      if (sort === 'updated-asc') {
        return a.updatedAt - b.updatedAt;
      }
      return b.updatedAt - a.updatedAt;
    });
    return result;
  }, [courses, search, sort]);

  return (
    <div className="flex flex-col">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="kicker">Material</p>
          <h1 className="mt-2 font-display text-4xl font-bold">What you are studying from.</h1>
          <p className="mt-1 font-serif text-[17px] leading-8 text-foreground-soft">
            Notes, slides, chapters, past papers — anything you revise from.
          </p>
        </div>
        {naming ? (
          <form
            className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center"
            onSubmit={(e) => {
              e.preventDefault();
              void createCourse();
            }}
          >
            <input
              autoFocus
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="What are you studying?"
              aria-label="What are you studying?"
              className="h-11 w-full rounded-md border border-line bg-surface px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-64"
            />
            <div className="flex gap-2">
              <Button type="submit" loading={creating} disabled={!newTitle.trim()} size="lg">
                Start
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="lg"
                onClick={() => {
                  setNaming(false);
                  setNewTitle('');
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <Button onClick={() => setNaming(true)} size="lg" aria-label="Add material">
            <svg
              className="mr-2 h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Add material
          </Button>
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div
          role="alert"
          className="mt-6 flex items-start justify-between gap-4 rounded-lg border border-error/30 bg-error-subtle px-4 py-3 text-sm text-error-subtle-foreground"
        >
          <span className="flex items-center gap-2">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-5 w-5 shrink-0"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            {error}
          </span>
          {!loading && (
            <Button variant="ghost" size="sm" onClick={loadCourses}>
              Retry
            </Button>
          )}
        </div>
      )}

      {/* Search + sort toolbar */}
      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <Input
            aria-label="Search your material"
            placeholder="Search your material…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="flex items-center gap-2">
          <label
            htmlFor="sort-course"
            className="text-sm font-medium text-muted-foreground"
          >
            Sort
          </label>
          <select
            id="sort-course"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortOrder)}
            className="h-11 rounded-xl border border-input bg-card px-3 py-2 text-base font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:text-sm"
          >
            <option value="updated-desc">Recently updated</option>
            <option value="updated-asc">Oldest updated</option>
            <option value="title">Title A–Z</option>
          </select>
        </div>
      </div>

      {/* Content */}
      <div className="mt-6">
        {loading ? (
          <div
            className="grid gap-4 md:grid-cols-2 lg:grid-cols-3"
            aria-label="Loading courses"
          >
            {Array.from({ length: 6 }).map((_, i) => (
              <CourseCardSkeleton key={i} />
            ))}
          </div>
        ) : error && courses.length === 0 ? (
          <Card className="py-12 text-center">
            <CardContent className="flex flex-col items-center">
              <Badge variant="error" dot>
                Unable to load
              </Badge>
              <h2 className="mt-4 text-lg font-medium">Something went wrong</h2>
              <p className="mt-1 text-muted-foreground">
                Your courses could not be loaded right now.
              </p>
              <Button onClick={loadCourses} className="mt-4">
                Try again
              </Button>
            </CardContent>
          </Card>
        ) : courses.length === 0 ? (
          <Card className="py-16 text-center">
            <CardContent className="flex flex-col items-center">
              <div className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-7 w-7"
                  aria-hidden="true"
                >
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="12" y1="12" x2="12" y2="18" />
                  <line x1="9" y1="15" x2="15" y2="15" />
                </svg>
              </div>
              <h2 className="mt-4 text-xl font-semibold tracking-tight">Nothing here yet</h2>
              <p className="mt-1 max-w-sm font-serif text-[15px] leading-7 text-muted-foreground">
                Add the notes, slides or chapters you are revising from. KLAXO turns them
                into a course with practice you can drill.
              </p>
              <Button onClick={() => setNaming(true)} className="mt-5">
                Add your first material
              </Button>
            </CardContent>
          </Card>
        ) : filteredCourses.length === 0 ? (
          <Card className="py-16 text-center">
            <CardContent className="flex flex-col items-center">
              <h2 className="text-xl font-semibold tracking-tight">No matches</h2>
              <p className="mt-1 font-serif text-[15px] leading-7 text-muted-foreground">
                No courses match &ldquo;{search.trim()}&rdquo;.
              </p>
              <Button variant="outline" onClick={() => setSearch('')} className="mt-5">
                Clear search
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {filteredCourses.map((course) => {
              const state = courseState(course);
              return (
                <Card
                  key={course.id}
                  className="group flex flex-col transition-shadow hover:shadow-md"
                >
                  <CardContent className="flex flex-1 flex-col gap-3 p-6">
                    <div className="flex items-start justify-between gap-3">
                      <h2 className="line-clamp-2 text-lg font-semibold leading-snug tracking-tight">
                        {course.title}
                      </h2>
                      <Badge variant={state.variant} dot className="shrink-0">
                        {state.label}
                      </Badge>
                    </div>

                    {course.description && (
                      <p className="line-clamp-2 text-sm text-muted-foreground">
                        {course.description}
                      </p>
                    )}

                    <div className="flex flex-wrap gap-2">
                      {course.subjectDomain && (
                        <Badge variant="secondary">{course.subjectDomain}</Badge>
                      )}
                      {course.targetLevel && (
                        <Badge variant="secondary">{labelize(course.targetLevel)}</Badge>
                      )}
                      {(course.questionCount ?? 0) > 0 && (
                        <Badge variant="outline">
                          {course.questionCount === 1
                            ? '1 question'
                            : `${course.questionCount} questions`}
                        </Badge>
                      )}
                    </div>

                    <div className="mt-auto flex items-center justify-between border-t pt-4">
                      <span className="text-xs text-muted-foreground">
                        Updated {formatRelative(course.updatedAt)}
                      </span>
                    </div>

                    <div className="flex gap-2.5">
                      <Link
                        href={`/wizard/${course.id}`}
                        className={cn(
                          'inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg border border-transparent bg-primary px-3 py-2 font-display text-sm font-semibold text-primary-foreground shadow-sm transition-all ease-standard hover:bg-primary-500 active:translate-y-px active:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                        )}
                      >
                        Continue
                      </Link>
                      <Link
                        href={`/workspace/${course.id}`}
                        className={cn(
                          'inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 font-display text-sm font-semibold shadow-sm transition-all ease-standard hover:bg-secondary active:translate-y-px active:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                        )}
                      >
                        Workspace
                      </Link>
                    </div>

                    {/* Nothing in the UI could remove a course, so an abandoned
                        one sat on this page forever. Two taps, in place — no
                        browser dialog. */}
                    {pendingDelete === course.id ? (
                      <div className="rounded-lg border border-error/30 bg-error-subtle p-3">
                        <p className="text-sm text-error-subtle-foreground">
                          Delete &ldquo;{course.title}&rdquo; and everything written for it? This
                          cannot be undone.
                        </p>
                        <div className="mt-3 flex gap-2">
                          <Button
                            variant="destructive"
                            size="sm"
                            loading={deletingId === course.id}
                            onClick={() => handleDelete(course.id)}
                          >
                            Delete it
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setPendingDelete(null)}
                          >
                            Keep it
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setPendingDelete(course.id)}
                        className="self-start text-xs font-medium text-muted-foreground underline-offset-4 hover:text-error hover:underline"
                      >
                        Delete this course
                      </button>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}