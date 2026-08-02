import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

/**
 * Public chapters list API — no auth required.
 * Returns chapter metadata (id, title, wordCount, sortOrder, createdAt) — NO content.
 * Capped at 500 chapters per request to prevent unbounded responses.
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

    // Cap result size to prevent unbounded responses on novels with 10K+ chapters
    const { searchParams } = new URL(request.url);
    const rawLimit = parseInt(searchParams.get("limit") || "500", 10) || 500;
    const limit = Math.min(500, Math.max(1, rawLimit));

    const chapters = await db.chapter.findMany({
      where: { novelId },
      orderBy: { sortOrder: "asc" },
      take: limit,
      select: {
        id: true,
        title: true,
        wordCount: true,
        sortOrder: true,
        createdAt: true,
      },
    });

    return NextResponse.json({
      chapters,
      total: chapters.length,
      truncated: chapters.length === limit,
    });
  } catch (error) {
    console.error("Public chapters list API error:", error);
    return NextResponse.json({ error: "获取章节列表失败" }, { status: 500 });
  }
}
