import { db } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { sanitizeField } from '@/lib/api-utils';
import { withPublicRateLimit } from '@/lib/api-auth';

// ─── Simple IP-based rate limiter ──────────────────────────────────
const _rateStore = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 60;
const RATE_WINDOW = 60_000;

function publicRateLimit(request: NextRequest): boolean {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const now = Date.now();
  const entry = _rateStore.get(ip);
  if (!entry || now > entry.resetAt) {
    _rateStore.set(ip, { count: 1, resetAt: now + RATE_WINDOW });
    return true;
  }
  entry.count++;
  if (entry.count > RATE_LIMIT) return false;
  return true;
}

if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now();
    for (const [key, val] of _rateStore) {
      if (now > val.resetAt) _rateStore.delete(key);
    }
  }, 60_000);
}

/**
 * Public search-suggestions API — no auth required.
 * Returns top 8 novel titles matching the query (case-insensitive).
 * GET ?q=keyword
 */
export const GET = withPublicRateLimit({ capacity: 30, refillRate: 2 }, async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const q = sanitizeField(searchParams.get('q'), 100);

    if (q.length < 2) {
      return NextResponse.json({ suggestions: [] });
    }

    const novels = await db.novel.findMany({
      where: {
        title: { contains: q },
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

    return NextResponse.json({ suggestions });
  } catch (error) {
    console.error('Search suggestions API error:', error);
    return NextResponse.json(
      { error: '获取搜索建议失败' },
      { status: 500 },
    );
  }
});
