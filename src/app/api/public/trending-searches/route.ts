import { db } from '@/lib/db';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
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

    return NextResponse.json({ trends });
  } catch {
    return NextResponse.json({ trends: [] });
  }
}
