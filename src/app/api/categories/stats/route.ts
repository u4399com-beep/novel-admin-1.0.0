import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { db } from '@/lib/db';
import { apiError } from '@/lib/api-utils';

export const GET = withAuth(async () => {
  try {
    const categories = await db.category.findMany({
      orderBy: { sortOrder: 'asc' },
      include: {
        _count: { select: { novels: true } },
      },
    });

    // Batch query: aggregate word counts and latest novel per category in 2 queries
    // instead of 2N+1 queries (N+1 anti-pattern fix)
    const wordCountByCategory = await db.novel.groupBy({
      by: ['categoryId'],
      _sum: { wordCount: true },
      where: { categoryId: { not: null } },
    });
    const wordCountMap = new Map(wordCountByCategory.map(r => [r.categoryId, Number(r._sum.wordCount || 0)]));

    // Latest novel per category: use a single query with window-function-like approach
    // For SQLite, we get all novels with their category and take the latest per category in JS
    const latestNovels = await db.novel.findMany({
      where: { categoryId: { not: null } },
      select: { categoryId: true, updatedAt: true, title: true },
      orderBy: { updatedAt: 'desc' },
    });
    const latestByCategory = new Map<string, { updatedAt: Date; title: string }>();
    for (const n of latestNovels) {
      if (!latestByCategory.has(n.categoryId)) {
        latestByCategory.set(n.categoryId, { updatedAt: n.updatedAt, title: n.title });
      }
    }

    const stats = categories.map(cat => {
      const latest = latestByCategory.get(cat.id);
      return {
        id: cat.id,
        name: cat.name,
        icon: cat.icon,
        color: cat.color,
        novelCount: cat._count.novels,
        totalWords: wordCountMap.get(cat.id) || 0,
        latestUpdate: latest?.updatedAt?.toISOString() || null,
        latestTitle: latest?.title || null,
      };
    });

    return NextResponse.json(stats);
  } catch (error) {
    console.error('Category stats error:', error);
    return apiError('获取分类统计失败');
  }
});
