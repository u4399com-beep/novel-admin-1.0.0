import { db } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { withPublicRateLimit } from '@/lib/api-auth';
import { sanitizeField } from '@/lib/api-utils';

const MAX_SESSION_ID_LENGTH = 100;

/**
 * GET /api/public/reading-stats?sessionId=xxx
 * Returns aggregate reading statistics for a session.
 */
export const GET = withPublicRateLimit({ capacity: 60, refillRate: 2 }, async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = sanitizeField(searchParams.get('sessionId') || '', MAX_SESSION_ID_LENGTH);
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

    // Total books with reading progress
    const totalBooks = await db.readingProgress.count({
      where: { sessionId },
    });

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
    const streak = await calculateReadingStreak(sessionId);

    return NextResponse.json({
      totalBooks,
      completedBooks,
      ongoingBooks,
      totalChaptersRead,
      genreDistribution,
      recentActivity,
      streak,
    });
  } catch (error) {
    console.error('Get reading stats error:', error);
    return NextResponse.json({ error: '获取阅读统计失败' }, { status: 500 });
  }
});

/**
 * Calculate reading streak — consecutive days with activity ending today or yesterday.
 */
async function calculateReadingStreak(sessionId: string): Promise<number> {
  try {
    // Get distinct dates of reading activity
    const progress = await db.readingProgress.findMany({
      where: { sessionId },
      select: { lastReadAt: true },
      orderBy: { lastReadAt: 'desc' },
      take: 365, // max 1 year of data
    });

    if (progress.length === 0) return 0;

    // Build set of date strings (YYYY-MM-DD)
    const dateSet = new Set<string>();
    for (const p of progress) {
      dateSet.add(p.lastReadAt.toISOString().slice(0, 10));
    }

    // Check if today or yesterday has activity
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().slice(0, 10);

    if (!dateSet.has(todayStr) && !dateSet.has(yesterdayStr)) return 0;

    // Count consecutive days backwards from today/yesterday
    const startDate = dateSet.has(todayStr) ? new Date(now) : yesterday;
    let streak = 0;
    const checkDate = new Date(startDate);

    while (dateSet.has(checkDate.toISOString().slice(0, 10))) {
      streak++;
      checkDate.setDate(checkDate.getDate() - 1);
    }

    return streak;
  } catch {
    return 0;
  }
}
