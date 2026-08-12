import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { db } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { apiError } from '@/lib/api-utils';

// GET /api/stats/word-count - Aggregate word count statistics
export const GET = withAuth(async () => {
  try {
    const totalResult = await db.chapter.aggregate({
      _sum: { wordCount: true },
      _count: true,
    });

    // Use aggregate query instead of loading all chapter rows per novel.
    // This is O(novels) instead of O(total_chapters), preventing memory issues
    // for novels with thousands of chapters.
    const avgByNovel = await db.$queryRaw<Array<{ novelId: string; title: string; totalWords: number; chapterCount: number }>>(
      Prisma.sql`
        SELECT
          n.id as "novelId",
          n.title as title,
          COALESCE(SUM(c."wordCount"), 0) as "totalWords",
          COUNT(c.id) as "chapterCount"
        FROM "Novel" n
        INNER JOIN "Chapter" c ON c."novelId" = n.id
        WHERE c."wordCount" > 0
        GROUP BY n.id, n.title
        ORDER BY "totalWords" DESC
        LIMIT 20
      `
    );

    const topNovels = avgByNovel.map((n) => ({
      title: n.title,
      totalWords: Number(n.totalWords),
      avgWordsPerChapter: n.chapterCount > 0 ? Math.round(n.totalWords / n.chapterCount) : 0,
      chapterCount: n.chapterCount,
    }));

    return NextResponse.json({
      totalWords: Number(totalResult._sum?.wordCount || 0),
      totalChapters: totalResult._count,
      topNovels,
    });
  } catch (error) {
    console.error('Word count stats error:', error);
    return apiError('获取字数统计失败');
  }
});
