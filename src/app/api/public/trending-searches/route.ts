import { db } from '@/lib/db';
import { NextResponse } from 'next/server';
import { withPublicRateLimit } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

export const GET = withPublicRateLimit({ capacity: 120, refillRate: 2 }, async () => {
  try {
    const grouped = await db.searchKeyword.groupBy({
      by: ['keyword'],
      _count: { keyword: true },
      orderBy: { _count: { keyword: 'desc' } },
      take: 8,
    });

    const trends = grouped.map((g) => ({
      keyword: g.keyword,
      count: g._count.keyword,
    }));

    return NextResponse.json({ trends }, { headers: { 'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=300' } });
  } catch {
    return NextResponse.json({ trends: [] });
  }
});
