/**
 * API: Source document analysis (multi-source).
 *
 * POST /api/courses/:id/analyze - analyze one or more source documents into a
 *   single knowledge package.
 *   body: { documentIds: string[] }
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUserId } from '@/lib/auth';
import { getCourse, listSourceDocuments } from '@/db/repo';
import { notFound, badRequest, toAppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { startJob } from '@/pipeline/orchestrator';
import { runClaimedJob } from '@/pipeline/job-runner';

const AnalyzeSchema = z.object({
  documentIds: z.array(z.string().min(1)).min(1).max(50),
});

/**
 * POST /api/courses/:id/analyze
 *
 * Runs analysis through a persisted job (idempotent via request key) so the
 * UI can poll progress and recover after refresh. Returns the job id.
 */
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

    const body = await req.json();
    const parsed = AnalyzeSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid input', details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    // Validate every document belongs to this course.
    const courseSources = listSourceDocuments(id);
    const courseSourceIds = new Set(courseSources.map((s) => s.id));
    for (const docId of parsed.data.documentIds) {
      if (!courseSourceIds.has(docId)) {
        throw badRequest(`Source document ${docId} does not belong to this course.`);
      }
    }

    // Idempotency key: same course + same source set → same job.
    const requestKey = `analyze:${id}:${[...parsed.data.documentIds].sort().join(',')}`;
    const { jobId, created } = startJob({
      courseId: id,
      userId,
      kind: 'ANALYZE_SOURCE',
      requestKey,
      input: { documentIds: parsed.data.documentIds },
    });

    if (created) {
      // Go through the same atomic claim as every other job. Calling runJob
      // directly let a deployed worker and this request execute the same job at
      // once, writing fragments and knowledge packages twice.
      void runClaimedJob(jobId).catch((err) => {
        logger.error('Analyze job failed', { jobId, error: (err as Error).message });
      });
    }

    return NextResponse.json({ jobId, created }, { status: created ? 201 : 200 });
  } catch (err) {
    const appErr = toAppError(err);
    return NextResponse.json(
      { error: appErr.message },
      { status: appErr.status },
    );
  }
}