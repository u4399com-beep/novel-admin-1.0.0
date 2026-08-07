import { db } from "@/lib/db";
import { sanitizeField, safeJson, isPrismaError, apiError, apiDeleted } from "@/lib/api-utils";
import { invalidateCache } from "@/lib/cache";
import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { getOrFail, NotFoundError } from "@/lib/crud-helpers";

const MAX_TITLE_LENGTH = 200;
const MAX_SORT_ORDER = 100000;
const MAX_CONTENT_LENGTH = 500000;

// GET /api/chapters/[id] - Get a single chapter
export const GET = withAuth(async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const chapter = await db.chapter.findUniqueOrThrow({
      where: { id },
      include: { novel: { select: { id: true, title: true } } },
    });
    return NextResponse.json(chapter);
  } catch (error) {
    if (isPrismaError(error, 'P2025')) {
      return apiError('章节不存在', 404);
    }
    console.error("Get chapter error:", error);
    return apiError("获取章节详情失败");
  }
});

// PUT /api/chapters/[id] - Update a chapter
export const PUT = withAuth(async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    let body;
    try {
      body = await safeJson(request);
    } catch {
      return apiError("请求数据格式错误", 400);
    }
    const { title, content, sortOrder } = body;

    if (title !== undefined) {
      const trimmed = sanitizeField(title, MAX_TITLE_LENGTH);
      if (!trimmed) {
        return apiError("章节标题不能为空", 400);
      }
    }
    if (sortOrder !== undefined) {
      const order = Math.floor(Number(sortOrder) || 0);
      if (order < 0 || order > MAX_SORT_ORDER) {
        return apiError(`排序值必须在0-${MAX_SORT_ORDER}之间`, 400);
      }
    }

    // Use transaction for atomic read-modify-write
    const chapter = await db.$transaction(async (tx) => {
      // Get old chapter for word count diff
      const oldChapter = await getOrFail<{ id: string; novelId: string; wordCount: number | null }>(tx.chapter, { id }, '章节不存在');

      const shouldUpdateWordCount = content !== undefined;
      const newContent = shouldUpdateWordCount
        ? sanitizeField(content, MAX_CONTENT_LENGTH)
        : "";
      const newWordCount = shouldUpdateWordCount
        ? newContent.length
        : oldChapter.wordCount || 0;
      const wordDiff = shouldUpdateWordCount
        ? newWordCount - (oldChapter.wordCount || 0)
        : 0;

      const updated = await tx.chapter.update({
        where: { id },
        data: {
          ...(title !== undefined && { title: sanitizeField(title, MAX_TITLE_LENGTH) }),
          ...(content !== undefined && { content: sanitizeField(content, MAX_CONTENT_LENGTH) || null }),
          ...(sortOrder !== undefined && { sortOrder: Math.floor(Number(sortOrder) || 0) }),
          ...(shouldUpdateWordCount && { wordCount: newWordCount }),
        },
      });

      // Update novel word count atomically (clamp to 0 minimum)
      if (wordDiff !== 0) {
        const currentNovel = await tx.novel.findUnique({ where: { id: oldChapter.novelId }, select: { wordCount: true } });
        const currentNovelWC = currentNovel?.wordCount || 0;
        const clampedDiff = Math.max(-currentNovelWC, wordDiff);
        if (clampedDiff !== 0) {
          await tx.novel.update({
            where: { id: oldChapter.novelId },
            data: { wordCount: { increment: clampedDiff } },
          });
        }
      }

      return updated;
    });

    invalidateCache("dashboard:stats");

    return NextResponse.json(chapter);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return apiError(error.message, 404);
    }
    console.error("Update chapter error:", error);
    return apiError("更新章节失败");
  }
});

// DELETE /api/chapters/[id] - Delete a chapter
export const DELETE = withAuth(async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // Use transaction for atomic delete + word count update
    await db.$transaction(async (tx) => {
      const chapter = await getOrFail<{ id: string; novelId: string; wordCount: number | null }>(tx.chapter, { id }, '章节不存在');

      // Update novel word count before deleting (clamp to avoid negative)
      const currentNovel = await tx.novel.findUnique({ where: { id: chapter.novelId }, select: { wordCount: true } });
      const currentNovelWC = currentNovel?.wordCount || 0;
      const clampedDecrement = Math.min(chapter.wordCount || 0, currentNovelWC);
      if (clampedDecrement > 0) {
        await tx.novel.update({
          where: { id: chapter.novelId },
          data: { wordCount: { decrement: clampedDecrement } },
        });
      }

      await tx.chapter.delete({ where: { id } });
    });

    invalidateCache("dashboard:stats");

    return apiDeleted();
  } catch (error) {
    if (error instanceof NotFoundError) {
      return apiError(error.message, 404);
    }
    console.error("Delete chapter error:", error);
    return apiError("删除章节失败");
  }
});
