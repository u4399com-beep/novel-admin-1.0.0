import { db } from "@/lib/db";
import { NextRequest } from "next/server";
import { parsePagination, sanitizeField, safeJson, apiError, apiSuccess } from "@/lib/api-utils";
import { invalidateCache } from "@/lib/cache";
import { withAuth } from "@/lib/api-auth";
import { paginatedList } from "@/lib/crud-helpers";
import { isSafeUrl } from "@/lib/sanitize";
import { VALID_NOVEL_STATUSES } from "@/lib/constants";

const MAX_SEARCH_LENGTH = 200;

// GET /api/novels - List novels with pagination, search, filter
export const GET = withAuth(async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const { page, pageSize } = parsePagination(searchParams, { defaultPageSize: 12 });
    const search = sanitizeField(searchParams.get("search"), MAX_SEARCH_LENGTH);
    const status = searchParams.get("status") || "";
    const categoryId = searchParams.get("categoryId") || "";
    const tagId = searchParams.get("tagId") || "";

    // Validate status enum
    if (status && !VALID_NOVEL_STATUSES.includes(status)) {
      return apiError("无效的状态筛选值", 400);
    }

    const where: Record<string, unknown> = {};

    if (search) {
      where.OR = [
        { title: { contains: search } },
        { author: { contains: search } },
        { description: { contains: search } },
      ];
    }
    if (status) {
      where.status = status;
    }
    if (categoryId) {
      where.categoryId = categoryId;
    }
    if (tagId) {
      where.tags = { some: { tagId } };
    }

    return paginatedList(db.novel, {
      page,
      pageSize,
      where,
      orderBy: { updatedAt: "desc" },
      include: {
        category: { select: { id: true, name: true, color: true, slug: true } },
        tags: { include: { tag: { select: { id: true, name: true, color: true } } } },
        _count: { select: { chapters: true } },
      },
      itemsKey: 'novels',
    });
  } catch (error) {
    console.error("List novels error:", error);
    return apiError("获取小说列表失败");
  }
});

// POST /api/novels - Create a novel
export const POST = withAuth(async function POST(request: NextRequest) {
  try {
    let body;
    try {
      body = await safeJson(request);
    } catch {
      return apiError("请求数据格式错误", 400);
    }
    const { title, author, description, coverUrl, status, categoryId, tags } = body;

    if (tags && (!Array.isArray(tags) || !tags.every((t: unknown) => typeof t === 'string'))) {
      return apiError("标签格式错误，必须是字符串ID数组", 400);
    }
    if (tags && tags.length > 20) {
      return apiError("标签数量不能超过20个", 400);
    }

    const trimmedTitle = sanitizeField(title, 200);
    if (!trimmedTitle) {
      return apiError("小说标题不能为空", 400);
    }

    const novelStatus = VALID_NOVEL_STATUSES.includes(status) ? status : "ongoing";

    // Validate categoryId existence if provided
    if (categoryId) {
      const categoryExists = await db.category.findUnique({ where: { id: categoryId } });
      if (!categoryExists) {
        return apiError("指定的分类不存在", 400);
      }
    }

    // Validate tag IDs existence if provided
    if (tags?.length) {
      const tagCount = await db.tag.count({
        where: { id: { in: tags } },
      });
      if (tagCount !== tags.length) {
        return apiError("部分标签ID不存在", 400);
      }
    }

    // Validate coverUrl protocol
    if (coverUrl) {
      if (!isSafeUrl(coverUrl)) {
        return apiError("封面URL格式不合法，仅允许http/https协议", 400);
      }
    }

    const novel = await db.novel.create({
      data: {
        title: trimmedTitle,
        author: sanitizeField(author, 100) || "佚名",
        description: sanitizeField(description, 5000) || null,
        coverUrl: sanitizeField(coverUrl, 2048) || null,
        status: novelStatus,
        categoryId: categoryId || null,
        tags: tags?.length
          ? {
              create: tags.map((tagId: string) => ({ tagId })),
            }
          : undefined,
      },
      include: {
        category: { select: { id: true, name: true, color: true, slug: true, icon: true } },
        tags: { include: { tag: { select: { id: true, name: true, color: true } } } },
        _count: { select: { chapters: true } },
      },
    });

    invalidateCache("dashboard:stats");
    invalidateCache("dashboard:activity");

    return apiSuccess(novel, 201);
  } catch (error) {
    console.error("Create novel error:", error);
    return apiError("创建小说失败");
  }
});