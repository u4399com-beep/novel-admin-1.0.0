import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

const MAX_TITLE_LENGTH = 200;
const MAX_SORT_ORDER = 100000;

// GET /api/chapters/[id] - Get a single chapter
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const chapter = await db.chapter.findUnique({
      where: { id },
      include: { novel: { select: { id: true, title: true } } },
    });

    if (!chapter) {
      return NextResponse.json({ error: "章节不存在" }, { status: 404 });
    }

    return NextResponse.json(chapter);
  } catch (error) {
    console.error("Get chapter error:", error);
    return NextResponse.json({ error: "获取章节详情失败" }, { status: 500 });
  }
}

// PUT /api/chapters/[id] - Update a chapter
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { title, content, sortOrder } = body;

    if (title !== undefined && !title?.trim()) {
      return NextResponse.json({ error: "章节标题不能为空" }, { status: 400 });
    }
    if (title !== undefined && title.trim().length > MAX_TITLE_LENGTH) {
      return NextResponse.json({ error: `章节标题不能超过${MAX_TITLE_LENGTH}个字符` }, { status: 400 });
    }
    if (sortOrder !== undefined) {
      const order = Math.floor(Number(sortOrder) || 0);
      if (order < 0 || order > MAX_SORT_ORDER) {
        return NextResponse.json({ error: `排序值必须在0-${MAX_SORT_ORDER}之间` }, { status: 400 });
      }
    }

    // Get old chapter for word count diff
    const oldChapter = await db.chapter.findUnique({ where: { id } });
    if (!oldChapter) {
      return NextResponse.json({ error: "章节不存在" }, { status: 404 });
    }

    const newWordCount = content !== undefined ? (content || "").length : oldChapter.wordCount;
    const wordDiff = newWordCount - oldChapter.wordCount;

    const chapter = await db.chapter.update({
      where: { id },
      data: {
        ...(title !== undefined && { title: title.trim() }),
        ...(content !== undefined && { content: content || null }),
        ...(sortOrder !== undefined && { sortOrder: Math.floor(Number(sortOrder) || 0) }),
        wordCount: newWordCount,
      },
    });

    // Update novel word count
    if (wordDiff !== 0) {
      await db.novel.update({
        where: { id: oldChapter.novelId },
        data: { wordCount: { increment: wordDiff } },
      });
    }

    return NextResponse.json(chapter);
  } catch (error) {
    console.error("Update chapter error:", error);
    return NextResponse.json({ error: "更新章节失败" }, { status: 500 });
  }
}

// DELETE /api/chapters/[id] - Delete a chapter
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const chapter = await db.chapter.findUnique({ where: { id } });
    if (!chapter) {
      return NextResponse.json({ error: "章节不存在" }, { status: 404 });
    }

    // Update novel word count
    await db.novel.update({
      where: { id: chapter.novelId },
      data: { wordCount: { decrement: chapter.wordCount } },
    });

    await db.chapter.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Delete chapter error:", error);
    return NextResponse.json({ error: "删除章节失败" }, { status: 500 });
  }
}