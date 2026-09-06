import { db } from '@/lib/db';
import { withAuth } from '@/lib/api-auth';
import { Prisma } from '@prisma/client';
import { apiError } from '@/lib/api-utils';

// GET /api/scrape-tasks/stats
export const GET = withAuth(async function GET() {
  try {
    // ── Aggregate stats ──
    const agg = await db.scrapeTask.aggregate({
      _count: true,
      _sum: {
        totalBooks: true,
        totalChapters: true,
        newBooks: true,
        newChapters: true,
      },
      where: {},
    });

    const statusCounts = await db.scrapeTask.groupBy({
      by: ['status'],
      _count: true,
    });

    const statusMap: Record<string, number> = {};
    for (const row of statusCounts) {
      statusMap[row.status] = row._count;
    }

    const totalTasks = agg._count;
    const completedTasks = statusMap['completed'] ?? 0;
    const failedTasks = statusMap['failed'] ?? 0;
    const runningTasks = statusMap['running'] ?? 0;
    const pendingTasks = statusMap['pending'] ?? 0;
    const cancelledTasks = statusMap['cancelled'] ?? 0;

    const successRate =
      completedTasks + failedTasks > 0
        ? Math.round((completedTasks / (completedTasks + failedTasks)) * 100)
        : 0;

    const totalBooksHarvested = agg._sum.newBooks ?? 0;
    const totalChaptersHarvested = agg._sum.newChapters ?? 0;

    // Average duration for completed tasks
    const completedWithDates = await db.scrapeTask.findMany({
      where: {
        status: 'completed',
        startedAt: { not: null },
        completedAt: { not: null },
      },
      select: { startedAt: true, completedAt: true },
    });

    let avgDuration = 0;
    if (completedWithDates.length > 0) {
      const totalMs = completedWithDates.reduce((sum, t) => {
        const start = t.startedAt!.getTime();
        const end = t.completedAt!.getTime();
        return sum + (end - start);
      }, 0);
      avgDuration = Math.round(totalMs / completedWithDates.length / 1000);
    }

    // Most recent createdAt
    const latestTask = await db.scrapeTask.findFirst({
      select: { createdAt: true },
      orderBy: { createdAt: 'desc' },
    });

    // ── Daily trend (last 14 days) ──
    const dailyTrend = await db.$queryRaw<
      Array<{
        date: string;
        tasks: number;
        completed: number;
        failed: number;
        books: number;
        chapters: number;
      }>
    >(Prisma.sql`
      SELECT
        strftime('%Y-%m-%d', "createdAt") as date,
        COUNT(*) as tasks,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        COALESCE(SUM("newBooks"), 0) as books,
        COALESCE(SUM("newChapters"), 0) as chapters
      FROM "ScrapeTask"
      WHERE "createdAt" >= strftime('%Y-%m-%d', 'now', '-14 days')
      GROUP BY strftime('%Y-%m-%d', "createdAt")
      ORDER BY date ASC
    `);

    return NextResponse.json({
      totalTasks,
      completedTasks,
      failedTasks,
      runningTasks,
      pendingTasks,
      cancelledTasks,
      successRate,
      totalBooksHarvested,
      totalChaptersHarvested,
      avgDuration,
      lastRunAt: latestTask?.createdAt?.toISOString() ?? null,
      dailyTrend,
    });
  } catch (error) {
    return apiError('获取采集任务统计失败', 500);
  }
});
