import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { db } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { apiError } from '@/lib/api-utils';

function todayStringLocal(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export const GET = withAuth(async () => {
  try {
    // Total chapters read (count unique chapters in reading progress with chapterIndex > 0)
    const chaptersReadResult = await db.readingProgress.aggregate({
      _count: true,
      _sum: { chapterIndex: true },
    });
    const totalChaptersRead = chaptersReadResult._count || 0;

    // Total words read (sum of wordCount for chapters)
    const totalWordsReadResult = await db.chapter.aggregate({
      _sum: { wordCount: true },
    });
    const totalWordsRead = Number(totalWordsReadResult._sum?.wordCount || 0);

    // Novels completed (reading progress has advanced past last chapter or status=completed)
    const novelsCompleted = await db.novel.count({
      where: { status: 'completed' },
    });

    // Total reading time (estimate: 300 chars/minute average reading speed for Chinese)
    const totalReadingTime = Math.round(totalWordsRead / 300); // minutes

    // Average words per session (estimated from daily reading records)
    const dailyRecords = await db.readingDaily.findMany({
      orderBy: { date: 'desc' },
      take: 30,
    });
    const avgWordsPerSession = dailyRecords.length > 0
      ? Math.round(dailyRecords.reduce((sum, d) => sum + d.words, 0) / dailyRecords.length)
      : 0;

    // Reading streak (consecutive days with reading activity)
    // Use local date string (not UTC) to match readingDaily.date storage format
    const allDailyDates = await db.readingDaily.findMany({
      where: { chapters: { gt: 0 } },
      orderBy: { date: 'desc' },
      select: { date: true },
    });

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
      const parts = checkDate.split('-');
      const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
      d.setDate(d.getDate() - 1);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      checkDate = `${y}-${m}-${day}`;
    }

    // Favorite genre (most read category based on novel reading progress)
    const genreStats = await db.readingProgress.groupBy({
      by: ['novelId'],
      _count: true,
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
