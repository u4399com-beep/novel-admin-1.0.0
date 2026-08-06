import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { db } from '@/lib/db';

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
    const allDailyDates = await db.readingDaily.findMany({
      where: { chapters: { gt: 0 } },
      orderBy: { date: 'desc' },
      select: { date: true },
    });

    let readingStreak = 0;
    const today = new Date();
    for (let i = 0; i < 365; i++) {
      const checkDate = new Date(today);
      checkDate.setDate(checkDate.getDate() - i);
      const dateStr = checkDate.toISOString().slice(0, 10);
      const found = allDailyDates.find((d) => d.date === dateStr);
      if (found) {
        readingStreak++;
      } else if (i > 0) {
        break; // Gap found, streak ended
      }
      // If i === 0 and not found, skip (today might not have reading yet)
      if (i === 0 && !found) continue;
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
    const progressRecords = await db.readingProgress.findMany({
      select: { lastReadAt: true },
    });

    const hourCounts: number[] = new Array(24).fill(0);
    for (const record of progressRecords) {
      const hour = new Date(record.lastReadAt).getHours();
      hourCounts[hour]++;
    }

    const mostActiveHour = hourCounts.indexOf(Math.max(...hourCounts));

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
    return NextResponse.json({ error: '获取阅读统计失败' }, { status: 500 });
  }
});
