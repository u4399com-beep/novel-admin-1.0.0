import { db } from '@/lib/db';
import { apiError, apiSuccess } from '@/lib/api-utils';
import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';

// GET /api/novels/[id]/notes?sessionId=xxx - 获取小说所有章节笔记
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const sessionId = request.nextUrl.searchParams.get('sessionId');

    if (!sessionId) {
      return apiError('缺少 sessionId 参数', 400);
    }

    const notes = await db.$queryRaw<Array<{
      chapterId: string;
      chapterIndex: number;
      chapterTitle: string;
      content: string;
      rating: number | null;
      updatedAt: Date;
    }>>(
      Prisma.sql`
        SELECT
          cn."chapterId",
          c."sortOrder"  AS "chapterIndex",
          c."title"      AS "chapterTitle",
          cn."content",
          cn."rating",
          cn."updatedAt"
        FROM "ChapterNote" cn
        JOIN "Chapter" c ON c."id" = cn."chapterId"
        WHERE cn."sessionId" = ${sessionId}
          AND c."novelId" = ${id}
        ORDER BY c."sortOrder" ASC
      `,
    );

    return apiSuccess({ notes });
  } catch {
    return apiError('获取笔记失败', 500);
  }
}
