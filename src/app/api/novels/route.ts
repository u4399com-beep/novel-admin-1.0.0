import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";
import { parsePagination, sanitizeField, safeJson } from "@/lib/api-utils";
import { invalidateCache } from "@/lib/cache";
import { withAuth } from "@/lib/api-auth";
import { isSafeUrl } from "@/lib/sanitize";
import { VALID_NOVEL_STATUSES } from "@/lib/constants";

const MAX_SEARCH_LENGTH = 200;

// GET /api/novels - List novels with pagination, search, filter
export const GET = withAuth(async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const { page, pageSize, skip } = parsePagination(searchParams, { defaultPageSize: 12 });
    const search = sanitizeField(searchParams.get("search"), MAX_SEARCH_LENGTH);
    const status = searchParams.get("status") || "";
    const categoryId = searchParams.get("categoryId") || "";
    const tagId = searchParams.get("tagId") || "";

    // Validate status enum
    if (status && !VALID_NOVEL_STATUSES.includes(status)) {
      return NextResponse.json({ error: "无效的状态筛选值" }, { status: 400 });
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

    const [novels, total] = await Promise.all([
      db.novel.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { updatedAt: "desc" },
        include: {
          category: true,
          tags: { include: { tag: true } },
          _count: { select: { chapters: true } },
        },
      }),
      db.novel.count({ where }),
    ]);

    return NextResponse.json({
      novels,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (error) {
    console.error("List novels error:", error);
    return NextResponse.json({ error: "获取小说列表失败" }, { status: 500 });
  }
});

// POST /api/novels - Create a novel
export const POST = withAuth(async function POST(request: NextRequest) {
  try {
    let body;
    try {
      body = await safeJson(request);
    } catch {
      return NextResponse.json({ error: "请求数据格式错误" }, { status: 400 });
    }
    const { title, author, description, coverUrl, status, categoryId, tags } = body;

    if (tags && (!Array.isArray(tags) || !tags.every((t: unknown) => typeof t === 'string'))) {
      return NextResponse.json({ error: "标签格式错误，必须是字符串ID数组" }, { status: 400 });
    }
    if (tags && tags.length > 20) {
      return NextResponse.json({ error: "标签数量不能超过20个" }, { status: 400 });
    }

    const trimmedTitle = sanitizeField(title, 200);
    if (!trimmedTitle) {
      return NextResponse.json({ error: "小说标题不能为空" }, { status: 400 });
    }

    const novelStatus = VALID_NOVEL_STATUSES.includes(status) ? status : "ongoing";

    // Validate categoryId existence if provided
    if (categoryId) {
      const categoryExists = await db.category.findUnique({ where: { id: categoryId } });
      if (!categoryExists) {
        return NextResponse.json({ error: "指定的分类不存在" }, { status: 400 });
      }
    }

    // Validate tag IDs existence if provided
    if (tags?.length) {
      const tagCount = await db.tag.count({
        where: { id: { in: tags } },
      });
      if (tagCount !== tags.length) {
        return NextResponse.json({ error: "部分标签ID不存在" }, { status: 400 });
      }
    }

    // Validate coverUrl protocol
    if (coverUrl) {
      if (!isSafeUrl(coverUrl)) {
        return NextResponse.json({ error: "封面URL格式不合法，仅允许http/https协议" }, { status: 400 });
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
        category: true,
        tags: { include: { tag: true } },
        _count: { select: { chapters: true } },
      },
    });

    invalidateCache("dashboard:stats");

    return NextResponse.json(novel, { status: 201 });
  } catch (error) {
    console.error("Create novel error:", error);
    return NextResponse.json({ error: "创建小说失败" }, { status: 500 });
  }
});