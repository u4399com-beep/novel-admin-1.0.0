import { db } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { sanitizeField } from '@/lib/api-utils';
import { getClientIp, publicRateLimit } from '@/lib/public-rate-limit';

/**
 * Public search-suggestions API — no auth required.
 * Returns top 8 novel titles matching the query (case-insensitive).
 * GET ?q=keyword
 */
export async function GET(request: NextRequest) {
  if (publicRateLimit(getClientIp(request))) {
    return NextResponse.json({ error: '请求过于频繁，请稍后再试' }, { status: 429 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const q = sanitizeField(searchParams.get('q'), 100);

    if (q.length < 2) {
      return NextResponse.json({ suggestions: [] });
    }

    const novels = await db.novel.findMany({
      where: {
        title: { startsWith: q, mode: 'insensitive' },
      },
      select: {
        id: true,
        title: true,
        author: true,
        category: {
          select: { name: true, color: true },
        },
      },
      take: 8,
      orderBy: { updatedAt: 'desc' },
    });

    const suggestions = novels.map((n) => ({
      id: n.id,
      title: n.title,
      author: n.author,
      category: n.category
        ? { name: n.category.name, color: n.category.color }
        : null,
    }));

    return NextResponse.json({ suggestions }, {
      headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
    });
  } catch (error) {
    console.error('Search suggestions API error:', error);
    return NextResponse.json(
      { error: '获取搜索建议失败' },
      { status: 500 },
    );
  }
}
