import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { publicRateLimit, getClientIp } from '@/lib/public-rate-limit';
import { apiError } from '@/lib/api-utils';
import { timingSafeEqual } from '@/lib/api-auth';

// GET /api/novels/by-source-url?sourceUrl=xxx
// 供scraper-service精确查找已存在小说
export async function GET(request: NextRequest) {
  // Service token auth (timing-safe comparison to prevent timing attacks)
  const serviceToken = process.env.SCRAPER_SERVICE_TOKEN || process.env.NEXTAUTH_SECRET;
  if (serviceToken) {
    const provided = request.headers.get('X-Service-Token');
    if (!provided || !timingSafeEqual(provided, serviceToken)) {
      return apiError('未授权', 401);
    }
  }

  if (publicRateLimit(getClientIp(request), 120)) {
    return apiError('请求过于频繁', 429);
  }

  const sourceUrl = request.nextUrl.searchParams.get('sourceUrl');
  if (!sourceUrl) {
    return apiError('缺少sourceUrl参数', 400);
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
}
