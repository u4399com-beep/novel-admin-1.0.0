import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

// GET /api/novels - List novels with pagination, search, filter
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get("page") || "1") || 1);
    const pageSize = Math.min(Math.max(1, parseInt(searchParams.get("pageSize") || "12") || 12), 100);
    const search = searchParams.get("search") || "";
    const status = searchParams.get("status") || "";
    const categoryId = searchParams.get("categoryId") || "";
    const tagId = searchParams.get("tagId") || "";

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
        skip: (page - 1) * pageSize,
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
}

// POST /api/novels - Create a novel
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { title, author, description, coverUrl, status, categoryId, tags } = body;

    if (!title?.trim()) {
      return NextResponse.json({ error: "小说标题不能为空" }, { status: 400 });
    }

    const validStatuses = ["ongoing", "completed", "hiatus"];
    const novelStatus = validStatuses.includes(status) ? status : "ongoing";

    const novel = await db.novel.create({
      data: {
        title: title.trim().slice(0, 200),
        author: (author?.trim() || "佚名").slice(0, 100),
        description: description?.trim()?.slice(0, 5000) || null,
        coverUrl: coverUrl?.trim() || null,
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

    return NextResponse.json(novel, { status: 201 });
  } catch (error) {
    console.error("Create novel error:", error);
    return NextResponse.json({ error: "创建小说失败" }, { status: 500 });
  }
}