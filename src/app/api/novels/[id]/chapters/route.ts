import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";
import { parsePagination, sanitizeField, safeJson } from "@/lib/api-utils";
import { invalidateCache } from "@/lib/cache";
import { withAuth } from "@/lib/api-auth";
import { isSafeUrl } from "@/lib/sanitize";

// GET /api/novels/[id]/chapters - List chapters for a novel (with pagination)
export const GET = withAuth(async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: novelId } = await params;
    const { searchParams } = new URL(request.url);
    const { page, pageSize, skip } = parsePagination(searchParams, { defaultPageSize: 50, maxPageSize: 500 });

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
    return NextResponse.json({ error: "获取章节列表失败"}, { status: 500 });
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
    if (trimmedSourceUrl && !isSafeUrl(trimmedSourceUrl)) {
      return NextResponse.json({ error: "sourceUrl 不允许访问内网或私有地址" }, { status: 400 });
    }

    // Use transaction to ensure atomicity
    const chapter = await db.$transaction(async (tx) => {
      // Use explicit sortOrder if provided, otherwise auto-calculate
      let sortOrder: number;
      if (explicitSortOrder !== undefined) {
        sortOrder = Math.max(0, Math.floor(Number(explicitSortOrder)) || 0);
      } else {
        const maxResult = await tx.$queryRaw<Array<{ max_order: number | null }>>`
          SELECT COALESCE(MAX("sortOrder"), 0) as max_order FROM "Chapter" WHERE "novelId" = ${novelId}
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
    invalidateCache("dashboard:activity");

    return NextResponse.json(chapter, { status: 201 });
  } catch (error) {
    console.error("Create chapter error:", error);
    return NextResponse.json({ error: "创建章节失败"}, { status: 500 });
  }
});

// PATCH /api/novels/[id]/chapters - Batch reorder or swap two chapters
// Body: { action: 'reorder', orders: [...] } or { action: 'swap', id1, id2 }
export const PATCH = withAuth(async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: novelId } = await params;

    let body;
    try {
      body = await safeJson(request);
    } catch {
      return NextResponse.json({ error: "请求数据格式错误" }, { status: 400 });
    }

    const action = body.action as string | undefined;

    // Verify novel exists
    const novelExists = await db.novel.findUnique({ where: { id: novelId }, select: { id: true } });
    if (!novelExists) {
      return NextResponse.json({ error: "小说不存在" }, { status: 404 });
    }

    if (action === 'swap') {
      // ─── Swap: exchange sortOrder of exactly 2 chapters (O(1) DB ops) ───
      const { id1, id2 } = body;
      if (!id1 || !id2 || id1 === id2) {
        return NextResponse.json({ error: "swap需要两个不同的chapter id" }, { status: 400 });
      }

      const [ch1, ch2] = await Promise.all([
        db.chapter.findUnique({ where: { id: id1, novelId }, select: { id: true, sortOrder: true } }),
        db.chapter.findUnique({ where: { id: id2, novelId }, select: { id: true, sortOrder: true } }),
      ]);
      if (!ch1 || !ch2) {
        return NextResponse.json({ error: "章节不存在或不属于该小说" }, { status: 404 });
      }

      await db.$transaction([
        db.chapter.update({ where: { id: ch1.id }, data: { sortOrder: ch2.sortOrder } }),
        db.chapter.update({ where: { id: ch2.id }, data: { sortOrder: ch1.sortOrder } }),
      ]);

      invalidateCache("dashboard:stats");
      return NextResponse.json({ success: true, action: 'swap' });
    }

    // ─── Batch reorder (drag-and-drop fallback, uses CASE WHEN for performance) ───
    const orders: Array<{ id: string; sortOrder: number }> = body.orders;
    if (!Array.isArray(orders) || orders.length === 0 || orders.length > 5000) {
      return NextResponse.json({ error: "orders 必须是非空数组(最多5000条)" }, { status: 400 });
    }

    // Validate structure
    for (const item of orders) {
      if (!item.id || typeof item.id !== 'string') {
        return NextResponse.json({ error: "每条记录必须有有效的id" }, { status: 400 });
      }
      const order = Math.floor(Number(item.sortOrder) || 0);
      if (order < 0 || order > 100000) {
        return NextResponse.json({ error: `sortOrder必须在0-100000之间(${item.id})` }, { status: 400 });
      }
    }

    // Single SQL UPDATE with VALUES clause for batch reorder (O(1) DB ops).
    // IDs are validated as cuid format from the frontend; escape single quotes.
    const values = orders
      .map((item) => `('${item.id.replace(/'/g, "''")}', ${Math.floor(Number(item.sortOrder) || 0)})`)
      .join(',');
    await db.$executeRaw`
      UPDATE "Chapter"
      SET "sortOrder" = v.sort_order
      FROM (VALUES ${Prisma.raw(values)}) AS v(id TEXT, sort_order INTEGER)
      WHERE "Chapter"."id" = v.id
      AND "Chapter"."novelId" = ${novelId}
    `;

    invalidateCache("dashboard:stats");

    return NextResponse.json({ success: true, updated: orders.length });
  } catch (error) {
    console.error("Batch reorder error:", error);
    return NextResponse.json({ error: "批量排序更新失败"}, { status: 500 });
  }
});