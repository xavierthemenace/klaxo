/**
 * API: Individual course CRUD.
 *
 * GET    /api/courses/:id           - get course details
 * PATCH  /api/courses/:id           - update course
 * DELETE /api/courses/:id           - delete course
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUserId } from '@/lib/auth';
import { requireCourseAccess } from '@/lib/course-access';
import { getCourse, updateCourse, deleteCourseCascade } from '@/db/repo';
import { notFound, toAppError } from '@/lib/errors';

const UpdateCourseSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).optional(),
  subjectDomain: z.string().optional(),
  targetLevel: z.string().optional(),
  status: z.enum(['draft', 'published', 'archived']).optional(),
  stage: z.string().optional(),
  preferences: z.record(z.string(), z.unknown()).optional(),
  currentVersionId: z.string().optional(),
});

/**
 * GET /api/courses/:id
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const userId = await requireUserId();
    const { id } = await params;

    // Learners enrolled through a share link may read the course too.
    const { course, access } = requireCourseAccess(id, userId, 'learner');

    return NextResponse.json({ course, access });
  } catch (err) {
    const appErr = toAppError(err);
    return NextResponse.json(
      { error: appErr.message },
      { status: appErr.status },
    );
  }
}

/**
 * PATCH /api/courses/:id
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const userId = await requireUserId();
    const { id } = await params;

    const course = getCourse(id);
    if (!course) throw notFound('Course not found');
    if (course.userId !== userId) {
      throw notFound('Course not found');
    }

    const body = await req.json();
    const parsed = UpdateCourseSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid input', details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const updated = updateCourse(id, {
      ...parsed.data,
      preferences: parsed.data.preferences ? JSON.stringify(parsed.data.preferences) : undefined,
    });

    return NextResponse.json({ course: updated });
  } catch (err) {
    const appErr = toAppError(err);
    return NextResponse.json(
      { error: appErr.message },
      { status: appErr.status },
    );
  }
}

/**
 * DELETE /api/courses/:id
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const userId = await requireUserId();
    const { id } = await params;

    const course = getCourse(id);
    if (!course) throw notFound('Course not found');
    if (course.userId !== userId) {
      throw notFound('Course not found');
    }

    // Removes the course's material too — deleting the row on its own trips a
    // FOREIGN KEY constraint for any course that has been worked on.
    deleteCourseCascade(id);

    return NextResponse.json({ success: true });
  } catch (err) {
    const appErr = toAppError(err);
    return NextResponse.json(
      { error: appErr.message },
      { status: appErr.status },
    );
  }
}