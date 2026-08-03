import { db } from '@/lib/db';
import { NextResponse } from 'next/server';
import { getOrCompute } from '@/lib/cache';
import { withAuth } from '@/lib/api-auth';
import { Prisma } from '@prisma/client';

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
      date: toLocalDateStr(d),
      start: d,
      end,
    });
  }

  // Optimized: 3 $queryRaw queries (one per entity) with CASE WHEN date bucketing
  // instead of 21 separate COUNT queries (7 days × 3 entities)
  // Uses Prisma.sql for parameterized queries (safe from injection)
  const weekAgo = days[0].start;
  const weekEnd = days[days.length - 1].end;

  // Safe table identifier mapping — hardcoded, no user input
  const TABLE_IDENTS = {
    Novel: Prisma.sql`"Novel"`,
    Chapter: Prisma.sql`"Chapter"`,
    ScrapeTask: Prisma.sql`"ScrapeTask"`,
  } as const;

  const buildCaseQuery = (table: 'Novel' | 'Chapter' | 'ScrapeTask') => {
    // Build CASE WHEN parts using Prisma.sql for parameterized date values
    const whenParts = days.map(
      (day) =>
        Prisma.sql`WHEN "createdAt" >= ${day.start.toISOString()} AND "createdAt" < ${day.end.toISOString()} THEN ${day.date}`
    );
    // Prisma.join safely concatenates Prisma.Sql objects with proper parameterization
    return db.$queryRaw<Array<{ bucket: string; cnt: number }>>(
      Prisma.sql`SELECT CASE ${Prisma.join(whenParts, ' ')} END AS bucket, COUNT(*) AS cnt FROM ${TABLE_IDENTS[table]} WHERE "createdAt" >= ${weekAgo.toISOString()} AND "createdAt" < ${weekEnd.toISOString()} GROUP BY bucket`
    );
  };

  const [novelCounts, chapterCounts, taskCounts] = await Promise.all([
    buildCaseQuery('Novel'),
    buildCaseQuery('Chapter'),
    buildCaseQuery('ScrapeTask'),
  ]);

  // Build lookup maps
  const novelsByDate = new Map(novelCounts.map((r) => [r.bucket, Number(r.cnt)]));
  const chaptersByDate = new Map(chapterCounts.map((r) => [r.bucket, Number(r.cnt)]));
  const tasksByDate = new Map(taskCounts.map((r) => [r.bucket, Number(r.cnt)]));

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
