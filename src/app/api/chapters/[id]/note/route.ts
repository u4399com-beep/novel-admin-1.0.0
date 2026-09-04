import { db } from '@/lib/db';
import { sanitizeField, apiError, apiSuccess, safeJson } from '@/lib/api-utils';
import { NextRequest } from 'next/server';
import { withPublicRateLimit } from '@/lib/api-auth';

// GET /api/chapters/[id]/note?sessionId=xxx - 获取章节笔记
export const GET = withPublicRateLimit({ capacity: 60, refillRate: 2 }, async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const sessionId = request.nextUrl.searchParams.get('sessionId');

    if (!sessionId) {
      return apiError('缺少 sessionId 参数', 400);
    }

    const note = await db.chapterNote.findUnique({
      where: { chapterId_sessionId: { chapterId: id, sessionId } },
      select: { content: true, rating: true, updatedAt: true },
    });

    if (!note) {
      return apiError('笔记不存在', 404);
    }

    return apiSuccess(note);
  } catch {
    return apiError('获取笔记失败', 500);
  }
});

// PUT /api/chapters/[id]/note - 创建或更新章节笔记
export const PUT = withPublicRateLimit({ capacity: 30, refillRate: 1 }, async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    let body: Record<string, unknown>;
    try {
      body = await safeJson(request);
    } catch {
      return apiError('请求数据格式错误', 400);
    }

    const { sessionId, content, rating } = body as {
      sessionId?: string;
      content?: unknown;
      rating?: unknown;
    };

    if (!sessionId || typeof sessionId !== 'string') {
      return apiError('缺少 sessionId', 400);
    }

    if (typeof content !== 'string' || content.length > 2000) {
      return apiError('笔记内容不能超过2000个字符', 400);
    }

    if (rating !== undefined && rating !== null) {
      const r = Number(rating);
      if (!Number.isInteger(r) || r < 1 || r > 5) {
        return apiError('评分必须是1-5的整数', 400);
      }
    }

    // Verify chapter exists
    const chapter = await db.chapter.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!chapter) {
      return apiError('章节不存在', 404);
    }

    const sanitizedContent = sanitizeField(content, 2000);
    const ratingValue = rating !== undefined && rating !== null ? Number(rating) : null;

    const note = await db.chapterNote.upsert({
      where: { chapterId_sessionId: { chapterId: id, sessionId } },
      create: {
        chapterId: id,
        sessionId,
        content: sanitizedContent,
        rating: ratingValue,
      },
      update: {
        content: sanitizedContent,
        rating: ratingValue,
      },
      select: { content: true, rating: true, updatedAt: true },
    });

    return apiSuccess(note);
  } catch {
    return apiError('保存笔记失败', 500);
  }
});
