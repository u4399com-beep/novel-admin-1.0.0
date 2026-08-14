import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { db } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { apiError } from '@/lib/api-utils';

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// GET /api/stats/weekday-distribution — reading activity by day of week
export const GET = withAuth(async () => {
  try {
    // Use ReadingDaily (has date field) to get chapters read per day of week
    const rows = await db.$queryRaw<Array<{ dow: number; totalChapters: number; totalWords: number; activeDays: number }>>(
      Prisma.sql`
        SELECT
          CAST(strftime('%w', date) AS INTEGER) as dow,
          SUM(chapters) as "totalChapters",
          SUM(words) as "totalWords",
          COUNT(*) as "activeDays"
        FROM "ReadingDaily"
        WHERE chapters > 0
        GROUP BY dow
      `
    );

    // Fill all 7 days with 0 for missing entries
    const distribution: Array<{
      dow: number;
      dayLabel: string;
      shortLabel: string;
      totalChapters: number;
      totalWords: number;
      activeDays: number;
    }> = [];

    const SHORT_LABELS = ['日', '一', '二', '三', '四', '五', '六'];
    const map = new Map(rows.map((r) => [r.dow, r]));

    for (let d = 0; d < 7; d++) {
      const r = map.get(d);
      distribution.push({
        dow: d,
        dayLabel: WEEKDAY_LABELS[d],
        shortLabel: SHORT_LABELS[d],
        totalChapters: Number(r?.totalChapters || 0),
        totalWords: Number(r?.totalWords || 0),
        activeDays: r?.activeDays || 0,
      });
    }

    return NextResponse.json({ distribution });
  } catch (error) {
    console.error('Weekday distribution stats error:', error);
    return apiError('获取星期分布失败');
  }
});
