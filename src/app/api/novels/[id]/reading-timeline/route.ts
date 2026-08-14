import { db } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { withPublicRateLimit } from '@/lib/api-auth';
import { apiError, sanitizeField } from '@/lib/api-utils';
import { Prisma } from '@prisma/client';

const MAX_SESSION_ID_LENGTH = 100;
const MAX_ID_LENGTH = 100;

export const GET = withPublicRateLimit({ capacity: 60, refillRate: 1 }, async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  try {
    const { id: novelId } = await params;
    const safeNovelId = sanitizeField(novelId, MAX_ID_LENGTH);
    if (!safeNovelId) {
      return apiError('无效的小说ID', 400);
    }

    const { searchParams } = new URL(request.url);
    const sessionId = sanitizeField(searchParams.get('sessionId') || '', MAX_SESSION_ID_LENGTH);
    if (!sessionId || sessionId.length < 20) {
      return NextResponse.json({ timeline: [], totalRead: 0 });
    }

    // Use Prisma.sql tagged template for safe parameterized query
    const results = await db.$queryRaw(
      Prisma.sql`
        SELECT
          rh."chapterId",
          COALESCE(c."sortOrder", 0) AS "chapterIndex",
          COALESCE(c."title", rh."chapterTitle") AS "chapterTitle",
          rh."readAt"
        FROM "ReadingHistory" rh
        LEFT JOIN "Chapter" c ON c."id" = rh."chapterId"
        WHERE rh."novelId" = ${safeNovelId} AND rh."sessionId" = ${sessionId}
        ORDER BY rh."readAt" DESC
        LIMIT 20
      `
    );

    const timeline = (results as Array<{
      chapterId: string | null;
      chapterIndex: number;
      chapterTitle: string | null;
      readAt: Date;
    }>).map((row) => ({
      chapterIndex: row.chapterIndex ?? 0,
      chapterTitle: row.chapterTitle ?? '',
      readAt: row.readAt.toISOString(),
      duration: null as number | null,
    }));

    const totalRead = timeline.length;

    return NextResponse.json({ timeline, totalRead });
  } catch (error) {
    return apiError('获取阅读时间线失败', 500);
  }
});
