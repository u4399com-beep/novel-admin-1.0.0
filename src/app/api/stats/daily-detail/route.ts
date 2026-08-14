import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { db } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { apiError } from '@/lib/api-utils';

// GET /api/stats/daily-detail?date=YYYY-MM-DD&sessionId=xxx
export const GET = withAuth(async (req) => {
  try {
    const url = new URL(req.url);
    const date = url.searchParams.get('date');
    const sessionId = url.searchParams.get('sessionId');

    if (!date) {
      return NextResponse.json({ error: '缺少日期参数' }, { status: 400 });
    }

    // Validate date format: YYYY-MM-DD
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: '日期格式无效，请使用 YYYY-MM-DD' }, { status: 400 });
    }

    // Get summary from readingDaily
    const daily = await db.readingDaily.findUnique({
      where: { date },
      select: { chapters: true, words: true },
    });

    // If no daily record and no sessionId, return 404
    if (!daily && !sessionId) {
      return NextResponse.json({ error: '该日无阅读记录' }, { status: 404 });
    }

    // Query detailed reading history for that date
    // Use local date formatting: readAt stored in UTC, compare using date string
    // The date boundary in local time: from date 00:00:00 to date+1 00:00:00
    // We convert to UTC by adding the timezone offset
    const dateStart = date + 'T00:00:00';
    const dateEnd = date + 'T23:59:59';

    // Use Prisma.sql tagged template for all queries
    const rows = await db.$queryRaw<
      Array<{
        novelId: string;
        novelTitle: string;
        chapterIndex: number | null;
        chapterTitle: string | null;
        words: number | null;
        readAt: string;
      }>
    >(
      Prisma.sql`
        SELECT
          rh."novelId",
          rh."novelTitle",
          c."sortOrder" as "chapterIndex",
          rh."chapterTitle",
          c."wordCount" as "words",
          rh."readAt"
        FROM "ReadingHistory" rh
        LEFT JOIN "Chapter" c ON rh."chapterId" = c."id"
        WHERE rh."sessionId" = ${sessionId}
          AND rh."readAt" >= ${dateStart}
          AND rh."readAt" <= ${dateEnd}
        ORDER BY rh."readAt" ASC
      `,
    );

    // If no daily record and no history rows, return 404
    if (!daily && rows.length === 0) {
      return NextResponse.json({ error: '该日无阅读记录' }, { status: 404 });
    }

    return NextResponse.json({
      date,
      chapters: daily?.chapters ?? rows.length,
      words: daily?.words ?? rows.reduce((sum, r) => sum + (r.words ?? 0), 0),
      novels: rows.map((r) => ({
        novelId: r.novelId,
        novelTitle: r.novelTitle,
        chapterIndex: r.chapterIndex ?? 0,
        chapterTitle: r.chapterTitle ?? '',
        words: r.words ?? 0,
        readAt: r.readAt,
      })),
    });
  } catch (error) {
    console.error('Daily detail stats error:', error);
    return apiError('获取每日阅读详情失败');
  }
});
