import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

/**
 * Public chapter content API — no auth required.
 * Returns full chapter (id, title, content, wordCount) with parent novel info.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const chapter = await db.chapter.findUnique({
      where: { id },
      include: {
        novel: { select: { id: true, title: true } },
      },
    });

    if (!chapter) {
      return NextResponse.json({ error: "章节不存在" }, { status: 404 });
    }

    return NextResponse.json({
      id: chapter.id,
      title: chapter.title,
      content: chapter.content,
      wordCount: chapter.wordCount,
      sortOrder: chapter.sortOrder,
      novel: chapter.novel,
    });
  } catch (error) {
    console.error("Public chapter content API error:", error);
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: "获取章节内容失败", detail: msg }, { status: 500 });
  }
}
