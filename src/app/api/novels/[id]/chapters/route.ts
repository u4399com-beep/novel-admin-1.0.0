import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";
import { parsePagination, sanitizeField, safeJson } from "@/lib/api-utils";
import { invalidateCache } from "@/lib/cache";
import { withAuth } from "@/lib/api-auth";

// GET /api/novels/[id]/chapters - List chapters for a novel (with pagination)
export const GET = withAuth(async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: novelId } = await params;
    const { searchParams } = new URL(request.url);
    const { page, pageSize, skip } = parsePagination(searchParams, { defaultPageSize: 50, maxPageSize: 100 });

    const [chapters, total] = await Promise.all([
      db.chapter.findMany({
        where: { novelId },
        orderBy: { sortOrder: "asc" },
        skip,
        take: pageSize,
        // Exclude content field from list to reduce response size by ~95%
        select: {
          id: true,
          title: true,
          sortOrder: true,
          wordCount: true,
          sourceUrl: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      db.chapter.count({ where: { novelId } }),
    ]);

    return NextResponse.json({
      chapters,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (error) {
    console.error("List chapters error:", error);
    return NextResponse.json({ error: "获取章节列表失败" }, { status: 500 });
  }
});

// POST /api/novels/[id]/chapters - Create a chapter
export const POST = withAuth(async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: novelId } = await params;

    // Verify novel exists before any DB operations
    const novelExists = await db.novel.findUnique({ where: { id: novelId }, select: { id: true } });
    if (!novelExists) {
      return NextResponse.json({ error: "小说不存在" }, { status: 404 });
    }

    let body;
    try {
      body = await safeJson(request);
    } catch {
      return NextResponse.json({ error: "请求数据格式错误" }, { status: 400 });
    }
    const { title, content, sourceUrl, sortOrder: explicitSortOrder } = body;

    const trimmedTitle = sanitizeField(title, 200);
    if (!trimmedTitle) {
      return NextResponse.json({ error: "章节标题不能为空" }, { status: 400 });
    }

    const trimmedContent = content ? sanitizeField(content, 500000) : null;
    const wordCount = trimmedContent ? trimmedContent.length : 0;
    const trimmedSourceUrl = sourceUrl ? sanitizeField(sourceUrl, 2048) : null;

    // Use transaction to ensure atomicity
    const chapter = await db.$transaction(async (tx) => {
      // Use explicit sortOrder if provided, otherwise auto-calculate
      let sortOrder: number;
      if (explicitSortOrder !== undefined) {
        sortOrder = Math.max(0, Math.floor(Number(explicitSortOrder)) || 0);
      } else {
        const maxResult = await tx.$queryRaw<Array<{ max_order: number | null }>>`
          SELECT COALESCE(MAX("sortOrder"), 0) as max_order FROM "Chapter" WHERE "novelId" = ${novelId} FOR UPDATE
        `;
        sortOrder = (maxResult[0]?.max_order ?? 0) + 1;
      }

      const newChapter = await tx.chapter.create({
        data: {
          title: trimmedTitle,
          content: trimmedContent,
          wordCount,
          sortOrder,
          novelId,
          ...(trimmedSourceUrl && { sourceUrl: trimmedSourceUrl }),
        },
      });

      // Update novel word count atomically
      if (wordCount > 0) {
        await tx.novel.update({
          where: { id: novelId },
          data: { wordCount: { increment: wordCount } },
        });
      }

      return newChapter;
    });

    invalidateCache("dashboard:stats");

    return NextResponse.json(chapter, { status: 201 });
  } catch (error) {
    console.error("Create chapter error:", error);
    return NextResponse.json({ error: "创建章节失败" }, { status: 500 });
  }
});