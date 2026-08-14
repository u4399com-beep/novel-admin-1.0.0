import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { db } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { apiError } from '@/lib/api-utils';

// GET /api/stats/hourly-distribution — reading activity by hour of day
export const GET = withAuth(async () => {
  try {
    const rows = await db.$queryRaw<Array<{ hour: number; cnt: number }>>(
      Prisma.sql`
        SELECT CAST(strftime('%H', "lastReadAt") AS INTEGER) as hour, COUNT(*) as cnt
        FROM "ReadingProgress"
        WHERE "lastReadAt" IS NOT NULL
        GROUP BY hour
      `
    );

    // Fill all 24 hours with 0 for missing entries
    const distribution: Array<{ hour: number; count: number; label: string }> = [];
    const map = new Map(rows.map((r) => [r.hour, r.cnt]));

    for (let h = 0; h < 24; h++) {
      distribution.push({
        hour: h,
        count: map.get(h) || 0,
        label: `${String(h).padStart(2, '0')}:00`,
      });
    }

    return NextResponse.json({ distribution });
  } catch (error) {
    console.error('Hourly distribution stats error:', error);
    return apiError('获取时段分布失败');
  }
});
