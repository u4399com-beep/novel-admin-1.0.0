import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";
import { withPublicRateLimit } from "@/lib/api-auth";
import { apiError, parsePagination } from "@/lib/api-utils";

/**
 * Public chapters list API — no auth required.
 * Returns chapter metadata (id, title, wordCount, sortOrder, createdAt) — NO content.
 * Supports pagination via page/pageSize params.
 */
export const GET = withPublicRateLimit({ capacity: 60, refillRate: 2 }, async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: novelId } = await params;

    // Verify novel exists
    const novel = await db.novel.findUnique({
      where: { id: novelId },
      select: { id: true },
    });
    if (!novel) {
      return apiError("小说不存在", 404);
    }

    const { searchParams } = new URL(request.url);
    const { page, pageSize, skip } = parsePagination(searchParams, {
      defaultPage: 1,
      defaultPageSize: 200,
      maxPageSize: 1000,
    });

    const [chapters, total] = await Promise.all([
      db.chapter.findMany({
        where: { novelId },
        orderBy: { sortOrder: "asc" },
        skip,
        take: pageSize,
        select: {
          id: true,
          title: true,
          wordCount: true,
          sortOrder: true,
          createdAt: true,
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
    console.error("Public chapters list API error:", error);
    return apiError("获取章节列表失败", 500);
  }
});
