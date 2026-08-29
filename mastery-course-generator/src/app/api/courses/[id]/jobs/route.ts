/**
 * API: Generation job management.
 *
 * POST /api/courses/:id/jobs          - start a new generation job
 * GET  /api/courses/:id/jobs          - list jobs for a course
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUserId } from '@/lib/auth';
import { getCourse, listGenerationJobs } from '@/db/repo';
import { runClaimedJob } from '@/pipeline/job-runner';
import { startJob } from '@/pipeline/orchestrator';
import { notFound, toAppError } from '@/lib/errors';
import { logger } from '@/lib/logger';

const StartJobSchema = z.object({
  kind: z.enum(['ANALYZE_SOURCE', 'BLUEPRINT', 'GENERATE_COURSE', 'REGENERATE_LESSON', 'QA', 'REVISE']),
  requestKey: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const userId = await requireUserId();
    const { id } = await params;
    const course = getCourse(id);
    if (!course) throw notFound('Course not found');
    if (course.userId !== userId) throw notFound('Course not found');

    const parsed = StartJobSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid input', details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const { jobId, created } = startJob({
      courseId: id,
      userId,
      kind: parsed.data.kind,
      requestKey: parsed.data.requestKey,
      input: parsed.data.input,
    });

    if (created) {
      // Dev fallback and the dedicated worker share the exact same atomic claim
      // path. If the worker wins, this returns false and does nothing.
      void runClaimedJob(jobId).catch((err) => {
        logger.error('In-process job execution failed', {
          jobId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    return NextResponse.json({ jobId, created }, { status: created ? 201 : 200 });
  } catch (err) {
    const appErr = toAppError(err);
    return NextResponse.json({ error: appErr.message }, { status: appErr.status });
  }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const userId = await requireUserId();
    const { id } = await params;
    const course = getCourse(id);
    if (!course) throw notFound('Course not found');
    if (course.userId !== userId) throw notFound('Course not found');

    return NextResponse.json({ jobs: listGenerationJobs(id) });
  } catch (err) {
    const appErr = toAppError(err);
    return NextResponse.json({ error: appErr.message }, { status: appErr.status });
  }
}
