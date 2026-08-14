import { NextRequest, NextResponse } from 'next/server';
import { withPublicRateLimit } from '@/lib/api-auth';
import { db } from '@/lib/db';
import { sanitizeField, apiError } from '@/lib/api-utils';

const MAX_SESSION_ID_LENGTH = 100;

interface LeaderboardEntry {
  novelId: string;
  title: string;
  author: string;
  coverUrl: string | null;
  completionPct: number;
  chaptersRead: number;
  totalChapters: number;
}

/**
 * GET /api/stats/completion-leaderboard?sessionId=xxx
 * Returns top 5 novels by reading completion percentage.
 */
export const GET = withPublicRateLimit({ capacity: 60, refillRate: 2 }, async function GET(request: NextRequest) {
  try {
    const sessionId = sanitizeField(new URL(request.url).searchParams.get('sessionId') || '', MAX_SESSION_ID_LENGTH);
    if (!sessionId || sessionId.length < 20) {
      return NextResponse.json({ leaderboard: [] });
    }

    // Get all reading progress for this session with novel chapter counts
    const progressItems = await db.readingProgress.findMany({
      where: { sessionId },
      select: {
        chapterIndex: true,
        novel: {
          select: {
            id: true,
            title: true,
            author: true,
            coverUrl: true,
            coverPath: true,
            _count: { select: { chapters: true } },
          },
        },
      },
    });

    if (progressItems.length === 0) {
      return NextResponse.json({ leaderboard: [] });
    }

    // Build leaderboard entries
    const entries: LeaderboardEntry[] = progressItems
      .map((item) => {
        const totalChapters = item.novel._count.chapters;
        const chaptersRead = item.chapterIndex + 1;
        const completionPct = totalChapters > 0 ? Math.round((chaptersRead / totalChapters) * 100) : 0;
        const coverUrl = item.novel.coverPath || item.novel.coverUrl;
        return {
          novelId: item.novel.id,
          title: item.novel.title,
          author: item.novel.author,
          coverUrl,
          completionPct: Math.min(completionPct, 100),
          chaptersRead,
          totalChapters,
        };
      })
      .filter((e) => e.totalChapters > 0)
      .sort((a, b) => b.completionPct - a.completionPct)
      .slice(0, 5);

    return NextResponse.json({ leaderboard: entries });
  } catch (error) {
    console.error('Completion leaderboard stats error:', error);
    return apiError('获取完成度排行榜失败', 500);
  }
});
