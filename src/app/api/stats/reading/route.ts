import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { db } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { apiError } from '@/lib/api-utils';
import { todayStringLocal, subtractDays } from '@/lib/format';

export const GET = withAuth(async () => {
  try {
    // Run independent queries in parallel for performance
    const [chaptersReadResult, totalWordsReadResult, novelsCompleted, dailyRecords, allDailyDates] = await Promise.all([
      db.readingProgress.aggregate({ _count: true, _sum: { chapterIndex: true } }),
      db.chapter.aggregate({ _sum: { wordCount: true } }),
      db.novel.count({ where: { status: 'completed' } }),
      db.readingDaily.findMany({ orderBy: { date: 'desc' }, take: 30 }),
      db.readingDaily.findMany({
        where: { chapters: { gt: 0 } },
        orderBy: { date: 'desc' },
        select: { date: true },
        take: 400,
      }),
    ]);

    const totalChaptersRead = chaptersReadResult._count || 0;
    const totalWordsRead = Number(totalWordsReadResult._sum?.wordCount || 0);
    const totalReadingTime = Math.round(totalWordsRead / 300); // minutes

    const avgWordsPerSession = dailyRecords.length > 0
      ? Math.round(dailyRecords.reduce((sum, d) => sum + d.words, 0) / dailyRecords.length)
      : 0;

    // Reading streak (consecutive days with reading activity)
    // Use local date string (not UTC) to match readingDaily.date storage format

    // Build a Set of active date strings for O(1) lookup
    const activeDates = new Set(allDailyDates.map(d => d.date));

    let readingStreak = 0;
    const todayStr = todayStringLocal();
    let checkDate = todayStr;

    for (let i = 0; i < 365; i++) {
      if (activeDates.has(checkDate)) {
        readingStreak++;
      } else if (i === 0) {
        // Today has no data yet — that's ok, don't count but keep checking yesterday
      } else {
        break; // Gap found, streak ended
      }
      // Move to previous day in local time
      checkDate = subtractDays(checkDate, 1);
    }

    // Favorite genre (most read category based on novel reading progress)
    // Limit groupBy to top 100 novels by reading-progress count
    // (Prisma requires orderBy whenever `take` is provided)
    const genreStats = await db.readingProgress.groupBy({
      by: ['novelId'],
      _count: true,
      take: 100,
      orderBy: { _count: { novelId: 'desc' } },
    });

    // Get categories for those novels
    const topNovelIds = genreStats
      .sort((a, b) => b._count - a._count)
      .slice(0, 5)
      .map((g) => g.novelId);

    const topNovels = await db.novel.findMany({
      where: { id: { in: topNovelIds } },
      select: { id: true, category: { select: { name: true } } },
    });

    const genreCounts: Record<string, number> = {};
    for (const novelId of topNovelIds) {
      const novel = topNovels.find((n) => n.id === novelId);
      if (novel?.category?.name) {
        genreCounts[novel.category.name] = (genreCounts[novel.category.name] || 0) + 1;
      }
    }

    const favoriteGenre = Object.entries(genreCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

    // Most active hour (from reading progress timestamps)
    // Use aggregate with GROUP BY to avoid loading all records into memory
    const hourStats = await db.$queryRaw<Array<{ hour: number; cnt: number }>>(Prisma.sql`
      SELECT CAST(strftime('%H', "lastReadAt") AS INTEGER) as hour, COUNT(*) as cnt
      FROM "ReadingProgress"
      GROUP BY hour
      ORDER BY cnt DESC
      LIMIT 24
    `);

    let mostActiveHour = 0;
    if (hourStats.length > 0) {
      mostActiveHour = hourStats[0].hour;
    }

    return NextResponse.json({
      totalReadingTime,
      totalWordsRead,
      totalChaptersRead,
      novelsCompleted,
      avgWordsPerSession,
      readingStreak,
      favoriteGenre,
      mostActiveHour,
    });
  } catch (error) {
    console.error('Reading stats error:', error);
    return apiError('获取阅读统计失败');
  }
});
