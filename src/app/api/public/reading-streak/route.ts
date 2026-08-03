import { db } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { withPublicRateLimit } from '@/lib/api-auth';
import { sanitizeField } from '@/lib/api-utils';
import { z } from 'zod';

function toLocalDateStr(d: Date): string {
  return d.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
}

const querySchema = z.object({
  sessionId: z.string().min(10, 'sessionId 长度不足 10 位'),
});

/**
 * GET /api/public/reading-streak?sessionId=xxx
 * Returns reading streak statistics for a given session.
 */
export const GET = withPublicRateLimit({ capacity: 60, refillRate: 2 }, async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const rawSessionId = sanitizeField(searchParams.get('sessionId') || '', 200);

    const parsed = querySchema.safeParse({ sessionId: rawSessionId });
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }

    const sessionId = parsed.data.sessionId;

    const progress = await db.readingProgress.findMany({
      where: { sessionId },
      select: { lastReadAt: true },
      orderBy: { lastReadAt: 'asc' },
    });

    if (progress.length === 0) {
      return NextResponse.json({ currentStreak: 0, maxStreak: 0, totalDays: 0 });
    }

    // Bucket by local date (Asia/Shanghai)
    const dateSet = new Set<string>();
    for (const p of progress) {
      dateSet.add(toLocalDateStr(p.lastReadAt));
    }

    const sortedDates = Array.from(dateSet).sort();
    const totalDays = sortedDates.length;

    // Calculate current streak: from today backwards
    const today = toLocalDateStr(new Date());
    let currentStreak = 0;
    if (dateSet.has(today)) {
      currentStreak = 1;
      for (let i = 1; ; i++) {
        const checkDate = new Date();
        checkDate.setDate(checkDate.getDate() - i);
        if (dateSet.has(toLocalDateStr(checkDate))) {
          currentStreak++;
        } else {
          break;
        }
      }
    }

    // Calculate max streak across all sorted dates
    let maxStreak = 1;
    let streak = 1;
    for (let i = 1; i < sortedDates.length; i++) {
      const prev = new Date(sortedDates[i - 1] + 'T00:00:00');
      const curr = new Date(sortedDates[i] + 'T00:00:00');
      const diffMs = curr.getTime() - prev.getTime();
      const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
      if (diffDays === 1) {
        streak++;
      } else {
        streak = 1;
      }
      if (streak > maxStreak) maxStreak = streak;
    }

    return NextResponse.json({ currentStreak, maxStreak, totalDays });
  } catch (error) {
    console.error('Get reading streak error:', error);
    return NextResponse.json({ error: '获取阅读连续天数失败' }, { status: 500 });
  }
});
