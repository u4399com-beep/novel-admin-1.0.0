import { db } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { withPublicRateLimit } from '@/lib/api-auth';
import { apiError, safeJson, sanitizeField, parsePagination, apiDeleted } from '@/lib/api-utils';
import { requireFields } from '@/lib/crud-helpers';

const MAX_SESSION_ID_LENGTH = 100;
const MAX_TITLE_LENGTH = 200;
const MAX_ID_LENGTH = 100;

/**
 * GET /api/public/reading-history?sessionId=xxx&page=1&pageSize=20
 * Returns reading history for a session, ordered by readAt desc.
 */
export const GET = withPublicRateLimit({ capacity: 60, refillRate: 1 }, async (request: NextRequest) => {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = sanitizeField(searchParams.get('sessionId') || '', MAX_SESSION_ID_LENGTH);
    if (!sessionId || sessionId.length < 20) {
      return NextResponse.json({ items: [], total: 0 });
    }

    const { page, pageSize, skip } = parsePagination(searchParams, { maxPageSize: 50 });

    const [items, total] = await Promise.all([
      db.readingHistory.findMany({
        where: { sessionId },
        orderBy: { readAt: 'desc' },
        take: pageSize,
        skip,
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

    return NextResponse.json({ items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) });
  } catch (error) {
    console.error('Get reading history error:', error);
    return apiError('获取阅读历史失败', 500);
  }
});

/**
 * POST /api/public/reading-history
 * Body: { sessionId, novelId, chapterId?, novelTitle, chapterTitle? }
 * Upserts reading history for a session+novel pair.
 */
export const POST = withPublicRateLimit({ capacity: 30, refillRate: 0.5 }, async (request: NextRequest) => {
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
    if (!sessionId || sessionId.length < 20) {
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

    // Upsert: use database-level unique constraint for atomicity
    await db.readingHistory.upsert({
      where: { sessionId_novelId: { sessionId, novelId } },
      update: {
        chapterId: chapterId ?? null,
        chapterTitle: chapterTitle ?? null,
        novelTitle,
        readAt: new Date(),
      },
      create: {
        sessionId,
        novelId,
        novelTitle,
        chapterId: chapterId ?? null,
        chapterTitle: chapterTitle ?? null,
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Save reading history error:', error);
    return apiError('保存阅读历史失败', 500);
  }
});

/**
 * DELETE /api/public/reading-history?id=xxx&sessionId=xxx
 * Deletes a reading history entry (only if sessionId matches).
 */
export const DELETE = withPublicRateLimit({ capacity: 10, refillRate: 0.2 }, async (request: NextRequest) => {
  try {
    const { searchParams } = new URL(request.url);
    const id = sanitizeField(searchParams.get('id') || '', MAX_ID_LENGTH);
    const sessionId = sanitizeField(searchParams.get('sessionId') || '', MAX_SESSION_ID_LENGTH);

    if (!id || !sessionId || sessionId.length < 20) {
      return apiError('缺少 id 或 sessionId', 400);
    }

    // Only delete if the sessionId matches (security: can't delete others' entries)
    const deleted = await db.readingHistory.deleteMany({
      where: { id, sessionId },
    });

    if (deleted.count === 0) {
      return apiError('记录不存在', 404);
    }

    return apiDeleted();
  } catch (error) {
    console.error('Delete reading history error:', error);
    return apiError('删除阅读历史失败', 500);
  }
});
