import { db } from "@/lib/db";
import { sanitizeField, safeJson, asString, asStringOrNull, isPrismaError, apiError, apiDeleted } from "@/lib/api-utils";
import { isSafeUrl } from "@/lib/sanitize";
import { invalidateCache } from "@/lib/cache";
import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { getOrFail, NotFoundError } from "@/lib/crud-helpers";
import { VALID_NOVEL_STATUSES } from "@/lib/constants";

// GET /api/novels/[id] - Get a single novel
export const GET = withAuth(async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const novel = await db.novel.findUniqueOrThrow({
      where: { id },
      include: {
        category: true,
        tags: { include: { tag: true } },
        _count: { select: { chapters: true } },
      },
    });
    return NextResponse.json(novel);
  } catch (error) {
    if (isPrismaError(error, 'P2025')) {
      return apiError('小说不存在', 404);
    }
    console.error("Get novel error:", error);
    return apiError("获取小说详情失败");
  }
});

// PUT /api/novels/[id] - Update a novel
export const PUT = withAuth(async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await getOrFail(db.novel, { id }, '小说不存在');

    let body;
    try {
      body = await safeJson(request);
    } catch {
      return apiError("请求数据格式错误", 400);
    }
    const { title, author, description, coverUrl, status, categoryId, tags, sourceUrl, coverPath } = body;

    if (tags !== undefined && (!Array.isArray(tags) || !tags.every((t: unknown) => typeof t === 'string'))) {
      return apiError("标签格式错误，必须是字符串ID数组", 400);
    }
    if (tags && tags.length > 20) {
      return apiError("标签数量不能超过20个", 400);
    }

    if (title !== undefined) {
      const trimmedTitle = sanitizeField(title, 200);
      if (!trimmedTitle) {
        return apiError("小说标题不能为空", 400);
      }
    }

    if (status !== undefined && !VALID_NOVEL_STATUSES.includes(status as string)) {
      return apiError("无效的小说状态", 400);
    }

    // Validate categoryId existence if provided
    const categoryIdStr = asStringOrNull(categoryId);
    if (categoryId !== undefined && categoryIdStr) {
      const categoryExists = await db.category.findUnique({ where: { id: categoryIdStr } });
      if (!categoryExists) {
        return apiError("指定的分类不存在", 400);
      }
    }

    // Validate tag IDs existence if provided
    if (tags !== undefined && Array.isArray(tags)) {
      const tagCount = await db.tag.count({
        where: { id: { in: tags } },
      });
      if (tagCount !== tags.length) {
        return apiError("部分标签ID不存在", 400);
      }
    }

    // Validate coverUrl protocol
    if (coverUrl !== undefined && coverUrl && !isSafeUrl(asString(coverUrl))) {
      return apiError("封面URL格式不合法，仅允许http/https协议", 400);
    }

    // Validate sourceUrl protocol (SSRF protection)
    if (sourceUrl !== undefined && sourceUrl && !isSafeUrl(asString(sourceUrl))) {
      return apiError("来源URL格式不合法，仅允许http/https协议", 400);
    }

    // Validate coverPath to prevent path traversal
    if (coverPath !== undefined && coverPath) {
      const cp = String(coverPath);
      const decoded = decodeURIComponent(cp).replace(/\\/g, '/');
      if (decoded.includes('..') || (!decoded.startsWith('/covers/') && !decoded.startsWith('/app/public/covers/'))) {
        return apiError("封面路径格式不合法", 400);
      }
    }

    // Use transaction for atomic tag update
    const novel = await db.$transaction(async (tx) => {
      // If tags are provided, delete old ones atomically with the update
      if (tags !== undefined) {
        await tx.novelTag.deleteMany({ where: { novelId: id } });
      }

      return tx.novel.update({
        where: { id },
        data: {
          ...(title !== undefined && { title: sanitizeField(title, 200) }),
          ...(author !== undefined && { author: sanitizeField(author, 100) || "佚名" }),
          ...(description !== undefined && { description: sanitizeField(description, 5000) || null }),
          ...(coverUrl !== undefined && { coverUrl: sanitizeField(coverUrl, 2048) || null }),
          ...(status !== undefined && { status: status as string }),
          ...(categoryId !== undefined && { categoryId: categoryIdStr || null }),
          ...(sourceUrl !== undefined && { sourceUrl: sanitizeField(sourceUrl, 2048) || null }),
          ...(coverPath !== undefined && { coverPath: coverPath ? String(coverPath) : null }),
          ...(tags !== undefined && {
            tags: tags.length
              ? {
                  create: tags.map((tagId: string) => ({ tagId })),
                }
              : undefined,
          }),
        },
        include: {
          category: true,
          tags: { include: { tag: true } },
          _count: { select: { chapters: true } },
        },
      });
    });

    invalidateCache("dashboard:stats");

    return NextResponse.json(novel);
  } catch (error: unknown) {
    if (error instanceof NotFoundError) {
      return apiError(error.message, 404);
    }
    console.error("Update novel error:", error);
    if (isPrismaError(error, "P2025")) {
      return apiError("小说不存在", 404);
    }
    return apiError("更新小说失败");
  }
});

// DELETE /api/novels/[id] - Delete a novel
export const DELETE = withAuth(async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await getOrFail(db.novel, { id }, '小说不存在');
    await db.novel.delete({ where: { id } });
    invalidateCache("dashboard:stats");
    return apiDeleted();
  } catch (error: unknown) {
    if (error instanceof NotFoundError) {
      return apiError(error.message, 404);
    }
    console.error("Delete novel error:", error);
    if (isPrismaError(error, "P2025")) {
      return apiError("小说不存在", 404);
    }
    return apiError("删除小说失败");
  }
});
