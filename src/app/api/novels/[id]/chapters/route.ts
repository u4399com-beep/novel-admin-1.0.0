import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

// GET /api/novels/[id]/chapters - List chapters for a novel
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: novelId } = await params;
    const chapters = await db.chapter.findMany({
      where: { novelId },
      orderBy: { sortOrder: "asc" },
    });
    return NextResponse.json(chapters);
  } catch (error) {
    console.error("List chapters error:", error);
    return NextResponse.json({ error: "获取章节列表失败" }, { status: 500 });
  }
}

// POST /api/novels/[id]/chapters - Create a chapter
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: novelId } = await params;
    const body = await request.json();
    const { title, content } = body;

    if (!title?.trim()) {
      return NextResponse.json({ error: "章节标题不能为空" }, { status: 400 });
    }

    // Get the max sortOrder for this novel
    const maxOrder = await db.chapter.findFirst({
      where: { novelId },
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });

    const wordCount = content ? content.length : 0;

    const chapter = await db.chapter.create({
      data: {
        title: title.trim(),
        content: content || null,
        wordCount,
        sortOrder: (maxOrder?.sortOrder || 0) + 1,
        novelId,
      },
    });

    // Update novel word count
    await db.novel.update({
      where: { id: novelId },
      data: { wordCount: { increment: wordCount } },
    });

    return NextResponse.json(chapter, { status: 201 });
  } catch (error) {
    console.error("Create chapter error:", error);
    return NextResponse.json({ error: "创建章节失败" }, { status: 500 });
  }
}