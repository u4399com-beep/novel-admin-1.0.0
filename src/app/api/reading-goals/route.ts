import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { safeJson, sanitizeField } from "@/lib/api-utils";

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_DAILY_GOAL = 10;

function todayString(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * GET /api/reading-goals?date=2025-08-04
 * Returns the reading progress for a given date (defaults to today).
 */
export const GET = withAuth(async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const dateParam = searchParams.get("date");
    const date = dateParam && DATE_REGEX.test(dateParam) ? dateParam : todayString();

    // Daily goal can be stored in SiteSetting, use default if not set
    const goalSetting = await db.siteSetting.findUnique({ where: { key: "dailyReadingGoal" } });
    const dailyGoal = goalSetting ? parseInt(goalSetting.value, 10) || DEFAULT_DAILY_GOAL : DEFAULT_DAILY_GOAL;

    const record = await db.readingDaily.findUnique({ where: { date } });
    const chaptersRead = record?.chapters ?? 0;
    const percentage = dailyGoal > 0 ? Math.min(100, Math.round((chaptersRead / dailyGoal) * 100)) : 0;

    // Calculate streak: count consecutive days with chapters > 0
    const streakDays = await calculateStreak(date);

    return NextResponse.json({
      date,
      chaptersRead,
      dailyGoal,
      percentage,
      streakDays,
    });
  } catch (error) {
    console.error("Reading goals GET error:", error);
    return NextResponse.json({ error: "获取阅读进度失败" }, { status: 500 });
  }
});

/**
 * POST /api/reading-goals
 * Body: { date?: string, chaptersRead: number, words?: number }
 * Records or updates daily reading data (upserts for the given date).
 */
export const POST = withAuth(async function POST(request: NextRequest) {
  try {
    let body;
    try {
      body = await safeJson(request);
    } catch {
      return NextResponse.json({ error: "请求数据格式错误" }, { status: 400 });
    }

    const { date: dateParam, chaptersRead: chaptersParam, words: wordsParam } = body;

    // Validate date — default to today
    let date = dateParam ? sanitizeField(dateParam, 10) : todayString();
    if (!DATE_REGEX.test(date)) {
      date = todayString();
    }

    const chaptersRead = Math.max(0, Math.floor(Number(chaptersParam) || 0));
    const words = Math.max(0, Math.floor(Number(wordsParam) || 0));

    // Upsert: increment existing record or create new
    await db.readingDaily.upsert({
      where: { date },
      create: { date, chapters: chaptersRead, words },
      update: {
        chapters: { increment: chaptersRead },
        words: { increment: words },
      },
    });

    // Fetch updated record for response
    const goalSetting = await db.siteSetting.findUnique({ where: { key: "dailyReadingGoal" } });
    const dailyGoal = goalSetting ? parseInt(goalSetting.value, 10) || DEFAULT_DAILY_GOAL : DEFAULT_DAILY_GOAL;

    const record = await db.readingDaily.findUnique({ where: { date } });
    const totalChapters = record?.chapters ?? chaptersRead;
    const percentage = dailyGoal > 0 ? Math.min(100, Math.round((totalChapters / dailyGoal) * 100)) : 0;
    const streakDays = await calculateStreak(date);

    return NextResponse.json({
      date,
      chaptersRead: totalChapters,
      dailyGoal,
      percentage,
      streakDays,
      added: chaptersRead,
    });
  } catch (error) {
    console.error("Reading goals POST error:", error);
    return NextResponse.json({ error: "记录阅读数据失败" }, { status: 500 });
  }
});

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Calculate consecutive reading streak ending at the given date.
 * Counts backwards from `date` while each day has chapters > 0.
 */
async function calculateStreak(date: string): Promise<number> {
  let streak = 0;
  let checkDate = date;

  // Check up to 365 days back
  for (let i = 0; i < 365; i++) {
    const record = await db.readingDaily.findUnique({ where: { date: checkDate } });
    if (record && record.chapters > 0) {
      streak++;
    } else if (i === 0) {
      // Today has no data yet — that's ok, don't count but keep checking yesterday
    } else {
      break;
    }
    // Move to previous day
    const parts = checkDate.split("-");
    const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    d.setDate(d.getDate() - 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    checkDate = `${y}-${m}-${day}`;
  }

  return streak;
}
