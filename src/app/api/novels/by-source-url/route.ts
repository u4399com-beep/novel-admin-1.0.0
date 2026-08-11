import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { withAuth } from '@/lib/api-auth';
import { apiError } from '@/lib/api-utils';

/**
 * GET /api/novels/by-source-url?sourceUrl=xxx
 * 供scraper-service精确查找已存在小说
 * Uses standard withAuth (service token via Bearer header)
 */
export const GET = withAuth(async (request: NextRequest) => {
  const sourceUrl = request.nextUrl.searchParams.get('sourceUrl');
  if (!sourceUrl) {
    return apiError('缺少sourceUrl参数', 400);
  }
  if (sourceUrl.length > 2048) {
    return apiError('sourceUrl过长', 400);
  }

  try {
    const novel = await db.novel.findFirst({
      where: { sourceUrl },
      select: {
        id: true,
        title: true,
        status: true,
        _count: { select: { chapters: true } },
      },
    });

    if (!novel) {
      return NextResponse.json({ found: false });
    }

    return NextResponse.json({
      found: true,
      novel: {
        id: novel.id,
        title: novel.title,
        status: novel.status,
        chapterCount: novel._count.chapters,
      },
    });
  } catch (error) {
    console.error('By-source-url query error:', error);
    return apiError('查询小说失败');
  }
});
