import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

/**
 * Public chapters list API — no auth required.
 * Returns chapter metadata (id, title, wordCount, sortOrder, createdAt) — NO content.
 * Supports pagination via page/pageSize params.
 */
export async function GET(
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
      return NextResponse.json({ error: "小说不存在" }, { status: 404 });
    }

    const { searchParams } = new URL(request.url);
    const rawPage = searchParams.get("page") || "1";
    const rawSize = searchParams.get("pageSize") || "500";
    const page = Math.max(1, parseInt(rawPage, 10) || 1);
    const pageSize = Math.min(500, Math.max(1, parseInt(rawSize, 10) || 500));
    const skip = (page - 1) * pageSize;

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
    return NextResponse.json({ error: "获取章节列表失败" }, { status: 500 });
  }
}
