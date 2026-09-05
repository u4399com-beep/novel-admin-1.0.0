import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";
import { parsePagination, sanitizeField, safeJson, asStringOrNull, apiError, apiSuccess } from "@/lib/api-utils";
import { invalidateCache } from "@/lib/cache";
import { withAuth } from "@/lib/api-auth";
import { paginatedList } from "@/lib/crud-helpers";
import { isSafeUrl } from "@/lib/sanitize";
import { Prisma } from "@prisma/client";

// GET /api/novels/[id]/chapters - List chapters for a novel (with pagination)
export const GET = withAuth(async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: novelId } = await params;
    const { searchParams } = new URL(request.url);

    // ─── Single-chapter TXT export ──────────────────────────────────
    if (searchParams.get('export') === 'txt') {
      const chapterId = searchParams.get('chapterId');
      if (!chapterId) return apiError('chapterId is required', 400);
      const [novel, chapter] = await Promise.all([
        db.novel.findUnique({ where: { id: novelId }, select: { title: true } }),
        db.chapter.findUnique({ where: { id: chapterId, novelId }, select: { title: true, content: true, novelId: true } }),
      ]);
      if (!chapter || !chapter.content) return apiError('章节内容为空', 404);
      if (!novel) return apiError('小说不存在', 404);
      const filename = `${novel?.title || 'novel'}_${chapter.title}.txt`;
      return new NextResponse(chapter.content, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        },
      });
    }

    const { page, pageSize } = parsePagination(searchParams, { defaultPageSize: 50, maxPageSize: 500 });

    return paginatedList(db.chapter, {
      page,
      pageSize,
      where: { novelId },
      orderBy: { sortOrder: "asc" },
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
      itemsKey: 'chapters',
    });
  } catch (error) {
    console.error("List chapters error:", error);
    return apiError("获取章节列表失败", 500);
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
      return apiError("小说不存在", 404);
    }

    let body;
    try {
      body = await safeJson(request);
    } catch {
      return apiError("请求数据格式错误", 400);
    }
    const { title, content, sourceUrl, sortOrder: explicitSortOrder } = body;

    const trimmedTitle = sanitizeField(title, 200);
    if (!trimmedTitle) {
      return apiError("章节标题不能为空", 400);
    }

    const trimmedContent = content ? sanitizeField(content, 500000) : null;
    // Count pure text characters (strip HTML tags and whitespace)
    const wordCount = trimmedContent ? trimmedContent.replace(/<[^>]*>/g, '').replace(/\s+/g, '').length : 0;
    const trimmedSourceUrl = sourceUrl ? sanitizeField(sourceUrl, 2048) : null;
    if (trimmedSourceUrl && !isSafeUrl(trimmedSourceUrl)) {
      return apiError("sourceUrl 不允许访问内网或私有地址", 400);
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

    return apiSuccess(chapter, 201);
  } catch (error) {
    console.error("Create chapter error:", error);
    return apiError("创建章节失败", 500);
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
      return apiError("请求数据格式错误", 400);
    }

    const action = body.action as string | undefined;

    // Verify novel exists
    const novelExists = await db.novel.findUnique({ where: { id: novelId }, select: { id: true } });
    if (!novelExists) {
      return apiError("小说不存在", 404);
    }

    if (action === 'swap') {
      // ─── Swap: exchange sortOrder of exactly 2 chapters (O(1) DB ops) ───
      const { id1, id2 } = body;
      const id1Str = asStringOrNull(id1);
      const id2Str = asStringOrNull(id2);
      if (!id1Str || !id2Str || id1Str === id2Str) {
        return apiError("swap需要两个不同的chapter id", 400);
      }

      const [ch1, ch2] = await Promise.all([
        db.chapter.findUnique({ where: { id: id1Str, novelId }, select: { id: true, sortOrder: true } }),
        db.chapter.findUnique({ where: { id: id2Str, novelId }, select: { id: true, sortOrder: true } }),
      ]);
      if (!ch1 || !ch2) {
        return apiError("章节不存在或不属于该小说", 404);
      }

      await db.$transaction([
        db.chapter.update({ where: { id: ch1.id }, data: { sortOrder: ch2.sortOrder } }),
        db.chapter.update({ where: { id: ch2.id }, data: { sortOrder: ch1.sortOrder } }),
      ]);

      invalidateCache("dashboard:stats");
      return NextResponse.json({ success: true, action: 'swap' });
    }

    // ─── Batch reorder (drag-and-drop fallback, uses CASE WHEN for performance) ───
    const orders = body.orders as Array<{ id: string; sortOrder: number }>;
    if (!Array.isArray(orders) || orders.length === 0 || orders.length > 5000) {
      return apiError("orders 必须是非空数组(最多5000条)", 400);
    }

    // Validate structure — CUID pattern: alphanumeric + hyphens, min 20 chars
    const CUID_RE = /^[a-z0-9-]{20,}$/;
    for (const item of orders) {
      if (!item.id || typeof item.id !== 'string' || !CUID_RE.test(item.id)) {
        return apiError("无效的ID格式", 400);
      }
      const order = Math.floor(Number(item.sortOrder) || 0);
      if (order < 0 || order > 100000) {
        return apiError(`sortOrder必须在0-100000之间(${item.id})`, 400);
      }
    }

    // Use CASE WHEN pattern for cross-database compatibility (works on both SQLite and PostgreSQL).
    // Each value is properly parameterized via Prisma.sql to prevent SQL injection.
    await db.$executeRaw`
      UPDATE "Chapter" SET "sortOrder" = CASE id
        ${Prisma.join(orders.map((item) =>
          Prisma.sql`WHEN ${item.id} THEN ${Math.floor(Number(item.sortOrder) || 0)}`
        ), ' ')}
        ELSE "sortOrder" END
      WHERE id IN (${Prisma.join(orders.map((item) => Prisma.sql`${item.id}`))})
      AND "novelId" = ${novelId}
    `;

    invalidateCache("dashboard:stats");

    return NextResponse.json({ success: true, updated: orders.length });
  } catch (error) {
    console.error("Batch reorder error:", error);
    return apiError("批量排序更新失败", 500);
  }
});