/**
 * API: Course workspace data (units, lessons, objectives, etc.)
 *
 * GET /api/courses/:id/workspace - get all curriculum entities for a course
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireUserId } from '@/lib/auth';
import { requireCourseAccess } from '@/lib/course-access';
import {
  listUnits,
  listObjectives,
  listLessons,
  listAssessments,
  listQuestions,
  listQuestionAttempts,
} from '@/db/repo';
import { toAppError } from '@/lib/errors';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const userId = await requireUserId();
    const { id } = await params;

    requireCourseAccess(id, userId, 'learner');

    const units = listUnits(id);
    const objectives = listObjectives(id);
    const lessons = listLessons(id);
    const assessments = listAssessments(id);
    const questions = listQuestions(id);

    // Most recent attempt per question. Without this, reloading the page came
    // back to a blank question with no sign it had ever been answered.
    // `listQuestionAttempts` is newest-first, so the first one wins.
    const latestAttemptByQuestion: Record<string, unknown> = {};
    for (const attempt of listQuestionAttempts(id, userId)) {
      if (!latestAttemptByQuestion[attempt.questionId]) {
        latestAttemptByQuestion[attempt.questionId] = attempt;
      }
    }

    return NextResponse.json({
      units,
      objectives,
      lessons,
      assessments,
      questions,
      attempts: latestAttemptByQuestion,
    });
  } catch (err) {
    const appErr = toAppError(err);
    return NextResponse.json(
      { error: appErr.message },
      { status: appErr.status },
    );
  }
}