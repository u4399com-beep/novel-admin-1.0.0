import { db } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { withPublicRateLimit } from '@/lib/api-auth';
import { sanitizeField, apiError } from "@/lib/api-utils";

const MAX_SESSION_ID_LENGTH = 100;

function toLocalDateStr(d: Date, tz?: string): string {
  return d.toLocaleString('sv-SE', { timeZone: tz || 'Asia/Shanghai' }).slice(0, 10);
}

/**
 * GET /api/public/reading-stats?sessionId=xxx
 * Returns aggregate reading statistics for a session.
 */
export const GET = withPublicRateLimit({ capacity: 60, refillRate: 2 }, async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = sanitizeField(searchParams.get('sessionId') || '', MAX_SESSION_ID_LENGTH);
    const tz = searchParams.get('tz') || undefined;
    if (!sessionId || sessionId.length < 10) {
      return NextResponse.json({
        totalBooks: 0,
        completedBooks: 0,
        ongoingBooks: 0,
        totalChaptersRead: 0,
        recentActivity: [],
        genreDistribution: [],
      });
    }

    // Get all progress items with novel info for analytics
    const progressItems = await db.readingProgress.findMany({
      where: { sessionId },
      orderBy: { lastReadAt: 'desc' },
      take: 100,
      select: {
        chapterIndex: true,
        lastReadAt: true,
        novel: {
          select: {
            id: true,
            title: true,
            author: true,
            status: true,
            category: { select: { name: true, color: true } },
            _count: { select: { chapters: true } },
          },
        },
      },
    });

    // Calculate stats
    let completedBooks = 0;
    let ongoingBooks = 0;
    let totalChaptersRead = 0;
    const genreMap = new Map<string, number>();

    for (const item of progressItems) {
      const chapters = item.novel._count.chapters;
      const currentChapter = item.chapterIndex + 1;
      totalChaptersRead += currentChapter;

      // A book is "completed" if the user has read >= 95% of chapters
      if (chapters > 0 && currentChapter >= chapters * 0.95) {
        completedBooks++;
      } else {
        ongoingBooks++;
      }

      // Genre distribution
      if (item.novel.category) {
        const name = item.novel.category.name;
        genreMap.set(name, (genreMap.get(name) || 0) + 1);
      }
    }

    // Build genre distribution array
    const genreDistribution = Array.from(genreMap.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    // Recent activity (last 10)
    const recentActivity = progressItems.slice(0, 10).map((item) => ({
      novelId: item.novel.id,
      novelTitle: item.novel.title,
      author: item.novel.author,
      chapterIndex: item.chapterIndex,
      totalChapters: item.novel._count.chapters,
      lastReadAt: item.lastReadAt.toISOString(),
      category: item.novel.category,
      status: item.novel.status,
    }));

    // Calculate reading streak (consecutive days with activity)
    const streak = calculateReadingStreak(progressItems.map(p => p.lastReadAt), tz);

    // Heatmap data: count of reading days per day for the last 120 days
    const heatmap = buildHeatmapData(progressItems.map(p => p.lastReadAt), 120, tz);

    const totalBooks = completedBooks + ongoingBooks;

    return NextResponse.json({
      totalBooks,
      completedBooks,
      ongoingBooks,
      totalChaptersRead,
      genreDistribution,
      recentActivity,
      streak,
      heatmap,
    });
  } catch (error) {
    console.error('Get reading stats error:', error);
    return apiError('获取阅读统计失败', 500);
  }
});

/**
 * Calculate reading streak — consecutive days with activity ending today or yesterday.
 */
function calculateReadingStreak(dates: Date[], tz?: string): number {
  if (dates.length === 0) return 0;

  const dateSet = new Set<string>();
  for (const d of dates) {
    dateSet.add(toLocalDateStr(d, tz));
  }

  // Check if today or yesterday has activity
  const now = new Date();
  const todayStr = toLocalDateStr(now, tz);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = toLocalDateStr(yesterday, tz);

  if (!dateSet.has(todayStr) && !dateSet.has(yesterdayStr)) return 0;

  // Count consecutive days backwards from today/yesterday
  const startDate = dateSet.has(todayStr) ? new Date(now) : yesterday;
  let streak = 0;
  const checkDate = new Date(startDate);

  while (dateSet.has(toLocalDateStr(checkDate, tz))) {
    streak++;
    checkDate.setDate(checkDate.getDate() - 1);
  }

  return streak;
}

/**
 * Build heatmap data: array of { date, count } for the last N days.
 */
function buildHeatmapData(dates: Date[], days: number, tz?: string): Array<{ date: string; count: number }> {
  const dayCount = new Map<string, number>();
  for (const d of dates) {
    const key = toLocalDateStr(d, tz);
    dayCount.set(key, (dayCount.get(key) || 0) + 1);
  }

  const result: Array<{ date: string; count: number }> = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = toLocalDateStr(d);
    result.push({ date: key, count: dayCount.get(key) || 0 });
  }
  return result;
}