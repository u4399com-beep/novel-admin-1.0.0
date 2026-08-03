import { db } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { withPublicRateLimit } from '@/lib/api-auth';
import { sanitizeField, safeJson } from '@/lib/api-utils';

const MAX_SESSION_ID_LENGTH = 100;
const MAX_PROGRESS_ITEMS = 50; // 每个会话最多追踪50本小说
const MAX_CHAPTER_INDEX = 100000;

/**
 * GET /api/public/reading-progress?sessionId=xxx
 * Returns all reading progress for a session, ordered by lastReadAt desc.
 * Includes novel basic info (id, title, author, coverUrl, status).
 */
export const GET = withPublicRateLimit({ capacity: 60, refillRate: 2 }, async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = sanitizeField(searchParams.get('sessionId') || '', MAX_SESSION_ID_LENGTH);
    if (!sessionId || sessionId.length < 10) {
      return NextResponse.json({ progress: [] });
    }

    const progress = await db.readingProgress.findMany({
      where: { sessionId },
      orderBy: { lastReadAt: 'desc' },
      take: MAX_PROGRESS_ITEMS,
      select: {
        id: true,
        novelId: true,
        chapterId: true,
        chapterIndex: true,
        scrollPercent: true,
        lastReadAt: true,
        novel: {
          select: {
            id: true,
            title: true,
            author: true,
            coverUrl: true,
            status: true,
            wordCount: true,
            category: { select: { name: true, color: true, slug: true } },
            _count: { select: { chapters: true } },
          },
        },
      },
    });

    return NextResponse.json({ progress });
  } catch (error) {
    console.error('Get reading progress error:', error);
    return NextResponse.json({ error: '获取阅读进度失败' }, { status: 500 });
  }
});

/**
 * POST /api/public/reading-progress
 * Body: { sessionId, novelId, chapterId?, chapterIndex, scrollPercent? }
 * Upserts reading progress for a session+novel pair.
 */
export const POST = withPublicRateLimit({ capacity: 30, refillRate: 1 }, async function POST(request: NextRequest) {
  try {
    let body;
    try {
      body = await safeJson(request);
    } catch {
      return NextResponse.json({ error: '请求数据格式错误' }, { status: 400 });
    }

    const { sessionId, novelId, chapterId, chapterIndex, scrollPercent } = body;

    // Validate required fields
    const sid = sanitizeField(sessionId, MAX_SESSION_ID_LENGTH);
    if (!sid || sid.length < 10) {
      return NextResponse.json({ error: 'sessionId 无效' }, { status: 400 });
    }
    const nid = sanitizeField(novelId, 50);
    if (!nid) {
      return NextResponse.json({ error: 'novelId 无效' }, { status: 400 });
    }

    const ci = typeof chapterIndex === 'number'
      ? Math.min(Math.max(0, Math.floor(chapterIndex)), MAX_CHAPTER_INDEX)
      : 0;
    const sp = typeof scrollPercent === 'number'
      ? Math.min(100, Math.max(0, scrollPercent))
      : null;
    const chId = typeof chapterId === 'string' ? sanitizeField(chapterId, 50) || null : null;

    // Verify novel exists
    const novel = await db.novel.findUnique({ where: { id: nid }, select: { id: true } });
    if (!novel) {
      return NextResponse.json({ error: '小说不存在' }, { status: 404 });
    }

    // Upsert reading progress
    const progress = await db.readingProgress.upsert({
      where: { sessionId_novelId: { sessionId: sid, novelId: nid } },
      create: {
        sessionId: sid,
        novelId: nid,
        chapterId: chId,
        chapterIndex: ci,
        scrollPercent: sp,
      },
      update: {
        chapterId: chId,
        chapterIndex: ci,
        scrollPercent: sp,
        lastReadAt: new Date(),
      },
    });

    return NextResponse.json({ success: true, id: progress.id });
  } catch (error) {
    console.error('Save reading progress error:', error);
    return NextResponse.json({ error: '保存阅读进度失败' }, { status: 500 });
  }
});

/**
 * DELETE /api/public/reading-progress?sessionId=xxx&novelId=yyy
 * Remove reading progress for a specific novel.
 */
export const DELETE = withPublicRateLimit(async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = sanitizeField(searchParams.get('sessionId') || '', MAX_SESSION_ID_LENGTH);
    const novelId = sanitizeField(searchParams.get('novelId') || '', 50);

    if (!sessionId || sessionId.length < 10 || !novelId) {
      return NextResponse.json({ error: '缺少 sessionId 或 novelId' }, { status: 400 });
    }

    await db.readingProgress.deleteMany({
      where: { sessionId, novelId },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Delete reading progress error:', error);
    return NextResponse.json({ error: '删除阅读进度失败' }, { status: 500 });
  }
});
