import { db } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { withPublicRateLimit } from '@/lib/api-auth';
import { sanitizeField, apiError } from "@/lib/api-utils";
import { getOrCompute } from '@/lib/cache';

function toLocalDateStr(d: Date, tz?: string): string {
  return d.toLocaleString('sv-SE', { timeZone: tz || 'Asia/Shanghai' }).slice(0, 10);
}

/**
 * GET /api/public/reading-heatMap?sessionId=xxx
 * Returns daily reading activity for the last 90 days.
 * Response: { dates: { [date: string]: number } } where value is chapters read that day.
 */
export const GET = withPublicRateLimit({ capacity: 60, refillRate: 2 }, async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = sanitizeField(searchParams.get('sessionId') || '', 100);
    const tz = sanitizeField(searchParams.get('tz') || '', 50) || undefined;
    if (!sessionId || sessionId.length < 20) {
      return NextResponse.json({ dates: {} });
    }

    // Hash sessionId to avoid cache key collision with `:` characters
    const cacheKeySid = sessionId.replace(/:/g, '_');
    const data = await getOrCompute(`heatMap:${cacheKeySid}`, 300_000, async () => {
      const ninetyDaysAgo = new Date();
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
      ninetyDaysAgo.setHours(0, 0, 0, 0);

      const progress = await db.readingProgress.findMany({
        where: {
          sessionId,
          lastReadAt: { gte: ninetyDaysAgo },
        },
        select: { lastReadAt: true, chapterIndex: true },
        orderBy: { lastReadAt: 'asc' },
      });

      // Group by local date, count unique chapters per day
      const dateMap: Record<string, Set<number>> = {};
      for (const p of progress) {
        const dateStr = toLocalDateStr(p.lastReadAt, tz);
        if (!dateMap[dateStr]) dateMap[dateStr] = new Set();
        dateMap[dateStr].add(p.chapterIndex);
      }

      // Convert sets to counts
      const dates: Record<string, number> = {};
      for (const [date, chapters] of Object.entries(dateMap)) {
        dates[date] = chapters.size;
      }
      return { dates };
    });

    return NextResponse.json(data);
  } catch (error) {
    console.error('Get reading heat map error:', error);
    return apiError('获取阅读热力图失败', 500);
  }
});
