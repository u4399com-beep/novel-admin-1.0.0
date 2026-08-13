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

// GET /api/stats/reading-trend — last 30 days daily reading data
export const GET = withAuth(async () => {
  try {
    const today = todayStringLocal();

    const records = await db.readingDaily.findMany({
      where: {
        date: {
          lte: today,
        },
      },
      orderBy: { date: 'asc' },
      take: 30,
      select: {
        date: true,
        chapters: true,
        words: true,
      },
    });

    const trend = records.map((r) => ({
      date: r.date,
      chapters: r.chapters,
      words: r.words,
    }));

    return NextResponse.json({ trend });
  } catch (error) {
    console.error('Reading trend stats error:', error);
    return apiError('获取阅读趋势失败');
  }
});
