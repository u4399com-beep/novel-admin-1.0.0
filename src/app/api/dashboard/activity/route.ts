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
      { error: '获取活动数据失败'},
      { status: 500 },
    );
  }
});

// ─── Daily Activity (last 7 days) ───────────────────────────────────────────

async function fetchDailyActivity(): Promise<DailyActivityRow[]> {
  // Generate a date spine for the last 7 days so every day appears even with 0 counts.
  // SQLite's date('now') returns UTC; we use that consistently.
  const rows = await db.$queryRawUnsafe<DailyActivityRow[]>(`
    SELECT
      d.date,
      COALESCE(n.cnt, 0) AS novelsCreated,
      COALESCE(ch.cnt, 0) AS chaptersCreated,
      COALESCE(s.cnt, 0) AS scrapeRuns
    FROM (
      SELECT date('now', '-6 days') AS date
      UNION ALL SELECT date('now', '-5 days')
      UNION ALL SELECT date('now', '-4 days')
      UNION ALL SELECT date('now', '-3 days')
      UNION ALL SELECT date('now', '-2 days')
      UNION ALL SELECT date('now', '-1 days')
      UNION ALL SELECT date('now', '0 days')
    ) d
    LEFT JOIN (
      SELECT date(createdAt) AS date, COUNT(*) AS cnt
      FROM Novel
      WHERE createdAt >= date('now', '-7 days')
      GROUP BY date(createdAt)
    ) n ON d.date = n.date
    LEFT JOIN (
      SELECT date(createdAt) AS date, COUNT(*) AS cnt
      FROM Chapter
      WHERE createdAt >= date('now', '-7 days')
      GROUP BY date(createdAt)
    ) ch ON d.date = ch.date
    LEFT JOIN (
      SELECT date(createdAt) AS date, COUNT(*) AS cnt
      FROM ScrapeTask
      WHERE createdAt >= date('now', '-7 days')
      GROUP BY date(createdAt)
    ) s ON d.date = s.date
    ORDER BY d.date
  `);

  return rows;
}

// ─── Recent Events (last 10) ────────────────────────────────────────────────

async function fetchRecentEvents(): Promise<RecentEventRow[]> {
  const rows = await db.$queryRawUnsafe<RecentEventRow[]>(`
    SELECT type, title, novelTitle, timestamp FROM (
      SELECT 'novel_created' AS type, title, NULL AS novelTitle, createdAt AS timestamp
      FROM Novel
      ORDER BY createdAt DESC
      LIMIT 10
      UNION ALL
      SELECT 'chapter_added' AS type, c.title, n.title AS novelTitle, c.createdAt AS timestamp
      FROM Chapter c
      INNER JOIN Novel n ON c."novelId" = n.id
      ORDER BY c.createdAt DESC
      LIMIT 10
      UNION ALL
      SELECT 'scrape_run' AS type, r.name, NULL AS novelTitle, t.createdAt AS timestamp
      FROM ScrapeTask t
      INNER JOIN ScrapeRule r ON t."ruleId" = r.id
      ORDER BY t.createdAt DESC
      LIMIT 10
    )
    ORDER BY timestamp DESC
    LIMIT 10
  `);

  return rows;
}
