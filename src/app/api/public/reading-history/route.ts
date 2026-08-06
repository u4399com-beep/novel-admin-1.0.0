import { db } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, publicRateLimit } from '@/lib/public-rate-limit';
import { apiError, safeJson, sanitizeField } from '@/lib/api-utils';
import { requireFields } from '@/lib/crud-helpers';

const MAX_SESSION_ID_LENGTH = 100;
const MAX_TITLE_LENGTH = 200;
const MAX_ID_LENGTH = 100;
const MAX_LIMIT = 50;

/**
 * GET /api/public/reading-history?sessionId=xxx&limit=20&offset=0
 * Returns reading history for a session, ordered by readAt desc.
 */
export async function GET(request: NextRequest) {
  if (publicRateLimit(getClientIp(request))) {
    return apiError('请求过于频繁，请稍后再试', 429);
  }

  try {
    const { searchParams } = new URL(request.url);
    const sessionId = sanitizeField(searchParams.get('sessionId') || '', MAX_SESSION_ID_LENGTH);
    if (!sessionId || sessionId.length < 10) {
      return NextResponse.json({ items: [], total: 0 });
    }

    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(searchParams.get('limit') || '20') || 20));
    const offset = Math.max(0, parseInt(searchParams.get('offset') || '0') || 0);

    const [items, total] = await Promise.all([
      db.readingHistory.findMany({
        where: { sessionId },
        orderBy: { readAt: 'desc' },
        take: limit,
        skip: offset,
        select: {
          id: true,
          sessionId: true,
          novelId: true,
          chapterId: true,
          novelTitle: true,
          chapterTitle: true,
          readAt: true,
        },
      }),
      db.readingHistory.count({
        where: { sessionId },
      }),
    ]);

    return NextResponse.json({ items, total });
  } catch (error) {
    console.error('Get reading history error:', error);
    return apiError('获取阅读历史失败', 500);
  }
}

/**
 * POST /api/public/reading-history
 * Body: { sessionId, novelId, chapterId?, novelTitle, chapterTitle? }
 * Upserts reading history for a session+novel pair.
 */
export async function POST(request: NextRequest) {
  if (publicRateLimit(getClientIp(request), 30)) {
    return apiError('请求过于频繁，请稍后再试', 429);
  }

  try {
    let body;
    try {
      body = await safeJson(request);
    } catch {
      return apiError('请求数据格式错误', 400);
    }

    const check = requireFields(body, ['sessionId', 'novelId', 'novelTitle']);
    if (!check.valid) return check.response;

    const sessionId = sanitizeField(body.sessionId, MAX_SESSION_ID_LENGTH);
    if (!sessionId || sessionId.length < 10) {
      return apiError('sessionId 无效', 400);
    }
    const novelId = sanitizeField(body.novelId, MAX_ID_LENGTH);
    if (!novelId) {
      return apiError('novelId 无效', 400);
    }
    const novelTitle = sanitizeField(body.novelTitle, MAX_TITLE_LENGTH);
    if (!novelTitle) {
      return apiError('novelTitle 无效', 400);
    }
    const chapterId = typeof body.chapterId === 'string'
      ? sanitizeField(body.chapterId, MAX_ID_LENGTH) || undefined
      : undefined;
    const chapterTitle = typeof body.chapterTitle === 'string'
      ? sanitizeField(body.chapterTitle, MAX_TITLE_LENGTH) || undefined
      : undefined;

    // Upsert: find existing entry for (sessionId, novelId) or create new
    const existing = await db.readingHistory.findFirst({
      where: { sessionId, novelId },
    });

    if (existing) {
      await db.readingHistory.update({
        where: { id: existing.id },
        data: {
          chapterId: chapterId ?? null,
          chapterTitle: chapterTitle ?? null,
          novelTitle,
          readAt: new Date(),
        },
      });
    } else {
      await db.readingHistory.create({
        data: {
          sessionId,
          novelId,
          novelTitle,
          chapterId: chapterId ?? null,
          chapterTitle: chapterTitle ?? null,
        },
      });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Save reading history error:', error);
    return apiError('保存阅读历史失败', 500);
  }
}

/**
 * DELETE /api/public/reading-history?id=xxx&sessionId=xxx
 * Deletes a reading history entry (only if sessionId matches).
 */
export async function DELETE(request: NextRequest) {
  if (publicRateLimit(getClientIp(request), 30)) {
    return apiError('请求过于频繁，请稍后再试', 429);
  }

  try {
    const { searchParams } = new URL(request.url);
    const id = sanitizeField(searchParams.get('id') || '', MAX_ID_LENGTH);
    const sessionId = sanitizeField(searchParams.get('sessionId') || '', MAX_SESSION_ID_LENGTH);

    if (!id || !sessionId || sessionId.length < 10) {
      return apiError('缺少 id 或 sessionId', 400);
    }

    // Only delete if the sessionId matches (security: can't delete others' entries)
    const deleted = await db.readingHistory.deleteMany({
      where: { id, sessionId },
    });

    if (deleted.count === 0) {
      return apiError('记录不存在', 404);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Delete reading history error:', error);
    return apiError('删除阅读历史失败', 500);
  }
}
