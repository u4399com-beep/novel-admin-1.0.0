import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { db } from '@/lib/db';
import { apiError } from '@/lib/api-utils';

function todayStringLocal(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// GET /api/stats/reading-speed — estimated reading speed trend (words/day)
export const GET = withAuth(async () => {
  try {
    const today = todayStringLocal();

    const records = await db.readingDaily.findMany({
      where: {
        date: { lte: today },
        words: { gt: 0 },
      },
      orderBy: { date: 'desc' },
      take: 90,
      select: { date: true, words: true, chapters: true },
    });
    records.reverse(); // now oldest-first for processing

    const trend = records.map((r) => ({
      date: r.date,
      words: r.words,
      chapters: r.chapters,
    }));

    // Calculate average words per reading day
    const totalWords = trend.reduce((s, t) => s + t.words, 0);
    const avgWordsPerDay = trend.length > 0 ? Math.round(totalWords / trend.length) : 0;

    // Calculate 7-day moving average
    const movingAvg: Array<{ date: string; avg: number }> = [];
    for (let i = 0; i < trend.length; i++) {
      if (i < 6) {
        // Not enough data for 7-day window, use partial average
        const window = trend.slice(0, i + 1);
        const sum = window.reduce((s, t) => s + t.words, 0);
        movingAvg.push({ date: trend[i].date, avg: Math.round(sum / window.length) });
      } else {
        const window = trend.slice(i - 6, i + 1);
        const sum = window.reduce((s, t) => s + t.words, 0);
        movingAvg.push({ date: trend[i].date, avg: Math.round(sum / 7) });
      }
    }

    return NextResponse.json({ trend, movingAvg, avgWordsPerDay });
  } catch (error) {
    console.error('Reading speed stats error:', error);
    return apiError('获取阅读速度趋势失败');
  }
});
