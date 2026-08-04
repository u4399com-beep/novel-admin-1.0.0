import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { withPublicRateLimit, getClientIp } from '@/lib/public-rate-limit';

// GET /api/novels/by-source-url?sourceUrl=xxx
// 供scraper-service精确查找已存在小说
export async function GET(request: NextRequest) {
  if (withPublicRateLimit(getClientIp(request), 120)) {
    return NextResponse.json({ error: '请求过于频繁' }, { status: 429 });
  }

  const sourceUrl = request.nextUrl.searchParams.get('sourceUrl');
  if (!sourceUrl) {
    return NextResponse.json({ error: '缺少sourceUrl参数' }, { status: 400 });
  }

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
}
