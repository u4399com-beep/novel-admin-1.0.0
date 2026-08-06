import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { db } from '@/lib/db';

// GET /api/stats/word-count - Aggregate word count statistics
export const GET = withAuth(async () => {
  try {
    const totalResult = await db.chapter.aggregate({
      _sum: { wordCount: true },
      _count: true,
    });

    const avgByNovel = await db.novel.findMany({
      select: {
        title: true,
        chapters: {
          select: { wordCount: true },
          where: { wordCount: { gt: 0 } },
        },
      },
      where: { chapters: { some: { wordCount: { gt: 0 } } } },
      take: 50,
    });

    const novelStats = avgByNovel.map((n) => {
      const total = n.chapters.reduce((s, c) => s + (c.wordCount || 0), 0);
      const avg = n.chapters.length > 0 ? Math.round(total / n.chapters.length) : 0;
      return { title: n.title, totalWords: total, avgWordsPerChapter: avg, chapterCount: n.chapters.length };
    }).sort((a, b) => b.totalWords - a.totalWords);

    return NextResponse.json({
      totalWords: Number(totalResult._sum?.wordCount || 0),
      totalChapters: totalResult._count,
      topNovels: novelStats.slice(0, 20),
    });
  } catch (error) {
    console.error('Word count stats error:', error);
    return NextResponse.json({ error: '获取字数统计失败' }, { status: 500 });
  }
});
