import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

/**
 * Public chapters list API — no auth required.
 * Returns chapter metadata (id, title, wordCount, sortOrder, createdAt) — NO content.
 */
export async function GET(
  _request: NextRequest,
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

    const chapters = await db.chapter.findMany({
      where: { novelId },
      orderBy: { sortOrder: "asc" },
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
    });
  } catch (error) {
    console.error("Public chapters list API error:", error);
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: "获取章节列表失败", detail: msg }, { status: 500 });
  }
}
