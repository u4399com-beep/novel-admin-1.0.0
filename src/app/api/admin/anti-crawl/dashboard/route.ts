import { db } from '@/lib/db';
import { withAuth } from '@/lib/api-auth';
import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';

// GET /api/admin/anti-crawl/dashboard - Aggregated monitoring stats
export const GET = withAuth(async function GET(_request: NextRequest) {
  try {
    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // Event counts by type — last 24h
    const counts24h = await db.$queryRaw<Array<{ eventType: string; count: bigint }>>(
      Prisma.sql`
      SELECT "eventType", COUNT(*) as count
      FROM "AntiCrawlEvent"
      WHERE "createdAt" >= ${twentyFourHoursAgo.toISOString()}
      GROUP BY "eventType"
    `);

    // Event counts by type — last 7 days
    const counts7d = await db.$queryRaw<Array<{ eventType: string; count: bigint }>>(
      Prisma.sql`
      SELECT "eventType", COUNT(*) as count
      FROM "AntiCrawlEvent"
      WHERE "createdAt" >= ${sevenDaysAgo.toISOString()}
      GROUP BY "eventType"
    `);

    // Convert bigint counts to numbers
    const countsByType24h: Record<string, number> = {};
    for (const row of counts24h) {
      countsByType24h[row.eventType] = Number(row.count);
    }

    const countsByType7d: Record<string, number> = {};
    for (const row of counts7d) {
      countsByType7d[row.eventType] = Number(row.count);
    }

    // Latest proxy pool stats
    const latestProxyStats = await db.proxyPoolStats.findFirst({
      orderBy: { capturedAt: 'desc' },
    });

    // Recent events (last 20)
    const recentEvents = await db.antiCrawlEvent.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    // Captcha trigger rate trend — hourly buckets for last 24h
    // SQLite doesn't have EXTRACT(HOUR), use strftime instead
    const captchaTrend = await db.$queryRaw<
      Array<{ hour: string; count: bigint }>
    >(
      Prisma.sql`
      SELECT
        strftime('%Y-%m-%dT%H:00:00', "createdAt") as hour,
        COUNT(*) as count
      FROM "AntiCrawlEvent"
      WHERE "eventType" = 'captcha_triggered'
        AND "createdAt" >= ${twentyFourHoursAgo.toISOString()}
      GROUP BY hour
      ORDER BY hour ASC
    `,
    );

    // Unresolved events count
    const unresolvedCount = await db.antiCrawlEvent.count({
      where: { resolved: false },
    });

    // Top domains by event count (last 24h)
    const topDomains = await db.$queryRaw<
      Array<{ domain: string; count: bigint }>
    >(
      Prisma.sql`
      SELECT "domain", COUNT(*) as count
      FROM "AntiCrawlEvent"
      WHERE "createdAt" >= ${twentyFourHoursAgo.toISOString()}
        AND "domain" IS NOT NULL
        AND "domain" != ''
      GROUP BY "domain"
      ORDER BY count DESC
      LIMIT 10
    `,
    );

    return NextResponse.json({
      countsByType24h,
      countsByType7d,
      unresolvedCount,
      latestProxyStats: latestProxyStats || null,
      recentEvents,
      captchaTrend: captchaTrend.map((r) => ({
        hour: r.hour,
        count: Number(r.count),
      })),
      topDomains: topDomains.map((r) => ({
        domain: r.domain,
        count: Number(r.count),
      })),
    });
  } catch (error) {
    console.error('Anti-crawl dashboard error:', error);
    return NextResponse.json({ error: '获取反爬监控面板数据失败' }, { status: 500 });
  }
});
