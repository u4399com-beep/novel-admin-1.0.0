import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { sanitizeField, apiError } from '@/lib/api-utils';
import { withPublicRateLimit } from '@/lib/api-auth';

/**
 * Public search-suggestions API — no auth required.
 * Returns top 8 novel titles matching the query (case-insensitive).
 * GET ?q=keyword
 */
export const GET = withPublicRateLimit({ capacity: 60, refillRate: 2 }, async (request: NextRequest) => {
  try {
    const { searchParams } = new URL(request.url);
    const q = sanitizeField(searchParams.get('q'), 100);

    if (q.length < 2) {
      return NextResponse.json({ suggestions: [] });
    }

    // SQLite does not support mode: "insensitive" — use $queryRaw with COLLATE NOCASE
    // Escape LIKE wildcards to prevent user input from affecting query semantics
    const escaped = q.replace(/%/g, '\\%').replace(/_/g, '\\_');
    const novels = await db.$queryRaw<Array<{
      id: string;
      title: string;
      author: string;
      categoryId: string | null;
      categoryName: string | null;
      categoryColor: string | null;
    }>>(
      Prisma.sql`SELECT n.id, n.title, n.author, n."categoryId",
        c.name AS "categoryName", c.color AS "categoryColor"
        FROM Novel n LEFT JOIN Category c ON n."categoryId" = c.id
        WHERE n.title LIKE ${escaped + '%'} COLLATE NOCASE ESCAPE '\\'
        ORDER BY n."updatedAt" DESC LIMIT 8`
    );

    const suggestions = novels.map((n) => ({
      id: n.id,
      title: n.title,
      author: n.author,
      category: n.categoryName
        ? { name: n.categoryName, color: n.categoryColor }
        : null,
    }));

    return NextResponse.json({ suggestions }, {
      headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
    });
  } catch (error) {
    console.error('Search suggestions API error:', error);
    return apiError('获取搜索建议失败', 500);
  }
});
