import { db } from '@/lib/db';
import { NextResponse } from 'next/server';
import { getOrCompute } from '@/lib/cache';
import { withAuth } from '@/lib/api-auth';

const ACTIVITY_CACHE_KEY = 'dashboard:activity';
const ACTIVITY_CACHE_TTL = 60 * 1000; // 60 seconds

// ─── Types ───────────────────────────────────────────────────────────────────

interface DailyActivityRow {
  date: string;
  novelsCreated: number;
  chaptersCreated: number;
  scrapeRuns: number;
}

interface RecentEventRow {
  type: string;
  title: string;
  novelTitle: string | null;
  timestamp: string;
}

export const GET = withAuth(async function GET() {
  try {
    const data = await getOrCompute(ACTIVITY_CACHE_KEY, ACTIVITY_CACHE_TTL, async () => {
      const [dailyActivity, recentEvents] = await Promise.all([
        fetchDailyActivity(),
        fetchRecentEvents(),
      ]);

      return { dailyActivity, recentEvents };
    });

    return NextResponse.json(data);
  } catch (error) {
    console.error('Dashboard activity error:', error);
    return NextResponse.json(
      { error: '获取活动数据失败' },
      { status: 500 },
    );
  }
});

// ─── Daily Activity (last 7 days) ───────────────────────────────────────────
// Uses app-level date math instead of SQLite-specific date() functions.
// Compatible with both SQLite and PostgreSQL.

/** Format a Date to YYYY-MM-DD in the server's local timezone (not UTC) */
function toLocalDateStr(d: Date): string {
  const tz = process.env.TZ || 'Asia/Shanghai';
  return d.toLocaleString('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
}

async function fetchDailyActivity(): Promise<DailyActivityRow[]> {
  // Build date range in app layer (works for both SQLite and PG)
  const now = new Date();
  const days: { date: string; start: Date; end: Date }[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    d.setHours(0, 0, 0, 0);
    const end = new Date(d);
    end.setDate(end.getDate() + 1);
    days.push({
      date: toLocalDateStr(d), // YYYY-MM-DD in server timezone
      start: d,
      end,
    });
  }

  // Use $queryRaw with SQL COUNT for O(1) aggregate queries (M5 fix)
  // Note: We can't use GROUP BY DATE() because SQLite strftime uses UTC,
  // but our app uses local timezone. Instead, we use 7 targeted COUNT queries
  // (one per day per entity) — still far less data than loading all rows.
  const weekAgo = days[0].start;

  // Batch: for each day, count novels/chapters/tasks in parallel
  const countPromises: Promise<void>[] = [];
  const novelsByDate = new Map<string, number>();
  const chaptersByDate = new Map<string, number>();
  const tasksByDate = new Map<string, number>();

  for (const day of days) {
    countPromises.push(
      db.novel.count({ where: { createdAt: { gte: day.start, lt: day.end } } }).then((c) => { novelsByDate.set(day.date, c); }),
      db.chapter.count({ where: { createdAt: { gte: day.start, lt: day.end } } }).then((c) => { chaptersByDate.set(day.date, c); }),
      db.scrapeTask.count({ where: { createdAt: { gte: day.start, lt: day.end } } }).then((c) => { tasksByDate.set(day.date, c); }),
    );
  }
  await Promise.all(countPromises);

  return days.map(({ date }) => ({
    date,
    novelsCreated: novelsByDate.get(date) || 0,
    chaptersCreated: chaptersByDate.get(date) || 0,
    scrapeRuns: tasksByDate.get(date) || 0,
  }));
}

// ─── Recent Events (last 10) ────────────────────────────────────────────────

async function fetchRecentEvents(): Promise<RecentEventRow[]> {
  const recentNovels = await db.novel.findMany({
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { title: true, createdAt: true },
  });

  const recentChapters = await db.chapter.findMany({
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      title: true,
      createdAt: true,
      novel: { select: { title: true } },
    },
  });

  const recentTasks = await db.scrapeTask.findMany({
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      createdAt: true,
      rule: { select: { name: true } },
    },
  });

  const events: RecentEventRow[] = [
    ...recentNovels.map(n => ({
      type: 'novel_created',
      title: n.title,
      novelTitle: null,
      timestamp: n.createdAt.toISOString(),
    })),
    ...recentChapters.map(c => ({
      type: 'chapter_added',
      title: c.title,
      novelTitle: c.novel.title,
      timestamp: c.createdAt.toISOString(),
    })),
    ...recentTasks.map(t => ({
      type: 'scrape_run',
      title: t.rule.name,
      novelTitle: null,
      timestamp: t.createdAt.toISOString(),
    })),
  ];

  events.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return events.slice(0, 10);
}
