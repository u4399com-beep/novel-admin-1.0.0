import { db } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { withPublicRateLimit } from '@/lib/api-auth';
import { sanitizeField, apiError } from "@/lib/api-utils";
import { z } from 'zod';
import { Prisma } from '@prisma/client';

function toLocalDateStr(d: Date, tz?: string): string {
  return d.toLocaleString('sv-SE', { timeZone: tz || 'Asia/Shanghai' }).slice(0, 10);
}

const querySchema = z.object({
  sessionId: z.string().min(10, 'sessionId 长度不足 10 位'),
});

/**
 * GET /api/public/reading-streak?sessionId=xxx
 * Returns reading streak statistics for a given session.
 *
 * When called without sessionId, returns global streak from ReadingDaily:
 * { streak, todayWords }
 *
 * When called with sessionId, returns per-session streak:
 * { currentStreak, maxStreak, totalDays, streak, todayWords }
 */
export const GET = withPublicRateLimit({ capacity: 60, refillRate: 2 }, async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const rawSessionId = sanitizeField(searchParams.get('sessionId') || '', 200);
    const tz = sanitizeField(searchParams.get('tz') || '', 50) || undefined;

    // ── Global streak (ReadingDaily) when no sessionId ──
    if (!rawSessionId) {
      const today = toLocalDateStr(new Date(), tz);

      // Bulk query: fetch all ReadingDaily records for the last 365 days in one DB call
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 364);
      const startDateStr = toLocalDateStr(startDate, tz);

      const records = await db.readingDaily.findMany({
        where: { date: { gte: startDateStr } },
        select: { date: true, chapters: true, words: true },
      });

      // Build a Set of dates with reading activity (chapters > 0)
      const activeDates = new Set<string>();
      let todayWords = 0;
      for (const r of records) {
        if (r.chapters > 0) activeDates.add(r.date);
        if (r.date === today) todayWords = r.words;
      }

      // Calculate streak by iterating backwards from today in-memory
      let streak = 0;
      const checkDate = new Date();
      for (let i = 0; i < 365; i++) {
        const dateStr = toLocalDateStr(checkDate, tz);
        if (activeDates.has(dateStr)) {
          streak++;
          checkDate.setDate(checkDate.getDate() - 1);
        } else if (i === 0) {
          // Today hasn't been read yet — check yesterday
          checkDate.setDate(checkDate.getDate() - 1);
          continue;
        } else {
          break;
        }
      }

      return NextResponse.json({ streak, todayWords });
    }

    // ── Per-session streak (ReadingProgress) ──
    const parsed = querySchema.safeParse({ sessionId: rawSessionId });
    if (!parsed.success) {
      return apiError(parsed.error.issues[0].message, 400);
    }

    const sessionId = parsed.data.sessionId;

    const dates = await db.$queryRaw<Array<{ date: string }>>(
      Prisma.sql`SELECT DISTINCT date("lastReadAt") as date FROM "ReadingProgress" WHERE "sessionId" = ${sessionId} AND "lastReadAt" >= date('now', '-365 days') ORDER BY date ASC`
    );
    const uniqueDates = dates.map(d => d.date);

    if (uniqueDates.length === 0) {
      return NextResponse.json({ currentStreak: 0, maxStreak: 0, totalDays: 0, streak: 0, todayWords: 0 });
    }

    const dateSet = new Set<string>(uniqueDates);
    const totalDays = uniqueDates.length;

    // Calculate current streak: from today backwards
    const today = toLocalDateStr(new Date(), tz);
    let currentStreak = 0;
    if (dateSet.has(today)) {
      currentStreak = 1;
      const maxCheck = Math.min(uniqueDates.length, 3650);
      for (let i = 1; i <= maxCheck; i++) {
        const checkDate = new Date();
        checkDate.setDate(checkDate.getDate() - i);
        if (dateSet.has(toLocalDateStr(checkDate, tz))) {
          currentStreak++;
        } else {
          break;
        }
      }
    }

    // Calculate max streak across all sorted dates
    let maxStreak = 1;
    let streak = 1;
    for (let i = 1; i < uniqueDates.length; i++) {
      const prev = new Date(uniqueDates[i - 1] + 'T00:00:00');
      const curr = new Date(uniqueDates[i] + 'T00:00:00');
      const diffDays = Math.round((curr.getTime() - prev.getTime()) / (1000 * 60 * 60 * 24));
      if (diffDays === 1) {
        streak++;
      } else {
        streak = 1;
      }
      if (streak > maxStreak) maxStreak = streak;
    }

    return NextResponse.json({ currentStreak, maxStreak, totalDays, streak: currentStreak, todayWords: 0 });
  } catch (error) {
    console.error('Get reading streak error:', error);
    return apiError('获取阅读连续天数失败', 500);
  }
});
