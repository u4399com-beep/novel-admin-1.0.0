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

    const stats = await Promise.all(
      categories.map(async (cat) => {
        const wordCount = await db.novel.aggregate({
          _sum: { wordCount: true },
          where: { categoryId: cat.id },
        });
        const latestNovel = await db.novel.findFirst({
          where: { categoryId: cat.id },
          orderBy: { updatedAt: 'desc' },
          select: { updatedAt: true, title: true },
        });
        return {
          id: cat.id,
          name: cat.name,
          icon: cat.icon,
          color: cat.color,
          novelCount: cat._count.novels,
          totalWords: Number(wordCount._sum?.wordCount || 0),
          latestUpdate: latestNovel?.updatedAt || null,
          latestTitle: latestNovel?.title || null,
        };
      })
    );

    return NextResponse.json(stats);
  } catch (error) {
    console.error('Category stats error:', error);
    return apiError('获取分类统计失败');
  }
});
