import { db } from '@/lib/db';
import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';

/**
 * GET /api/scrape-logs/stats
 *
 * Returns log statistics: level distribution, recent errors, and trend data.
 * Used by the admin dashboard to visualize scraping health.
 */
export const GET = withAuth(async function GET() {
  try {
    // Level distribution
    const levelStats = await db.$queryRaw<Array<{ level: string; count: bigint }>>(`
      SELECT level, COUNT(*) as count
      FROM ScrapeLog
      WHERE createdAt >= datetime('now', '-7 days')
      GROUP BY level
    `);

    // Recent errors (last 24h)
    const recentErrors = await db.$queryRaw<Array<{ id: string; taskId: string; message: string; url: string | null; createdAt: string }>>(`
      SELECT id, taskId, message, url, createdAt
      FROM ScrapeLog
      WHERE level = 'error' AND createdAt >= datetime('now', '-24 hours')
      ORDER BY createdAt DESC
      LIMIT 20
    `);

    // Daily log counts for the last 7 days (for trend chart)
    const dailyStats = await db.$queryRaw<Array<{ date: string; total: bigint; errors: bigint; warnings: bigint }>>(`
      SELECT
        DATE(createdAt) as date,
        COUNT(*) as total,
        SUM(CASE WHEN level = 'error' THEN 1 ELSE 0 END) as errors,
        SUM(CASE WHEN level = 'warn' THEN 1 ELSE 0 END) as warnings
      FROM ScrapeLog
      WHERE createdAt >= datetime('now', '-7 days')
      GROUP BY DATE(createdAt)
      ORDER BY date DESC
    `);

    // Top error messages (most common errors)
    const topErrors = await db.$queryRaw<Array<{ message: string; count: bigint }>>(`
      SELECT message, COUNT(*) as count
      FROM ScrapeLog
      WHERE level = 'error' AND createdAt >= datetime('now', '-7 days')
      GROUP BY message
      ORDER BY count DESC
      LIMIT 10
    `);

    // Total logs count
    const totalLogs = await db.scrapeLog.count({
      where: { createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
    });

    return NextResponse.json({
      levelDistribution: levelStats.map(r => ({ level: r.level, count: Number(r.count) })),
      recentErrors: recentErrors.map(r => ({
        id: r.id,
        taskId: r.taskId,
        message: r.message,
        url: r.url,
        createdAt: r.createdAt,
      })),
      dailyTrend: dailyStats.map(r => ({
        date: r.date,
        total: Number(r.total),
        errors: Number(r.errors),
        warnings: Number(r.warnings),
      })),
      topErrors: topErrors.map(r => ({ message: r.message, count: Number(r.count) })),
      totalLogs,
    });
  } catch (error) {
    console.error('Scrape log stats error:', error);
    return NextResponse.json({ error: '获取日志统计失败' }, { status: 500 });
  }
});
