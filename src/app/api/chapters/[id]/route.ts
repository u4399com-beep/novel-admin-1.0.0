import { db } from "@/lib/db";
import { sanitizeField } from "@/lib/api-utils";
import { NextRequest, NextResponse } from "next/server";

const MAX_TITLE_LENGTH = 200;
const MAX_SORT_ORDER = 100000;
const MAX_CONTENT_LENGTH = 500000;

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

    if (title !== undefined) {
      const trimmed = sanitizeField(title, MAX_TITLE_LENGTH);
      if (!trimmed) {
        return NextResponse.json({ error: "章节标题不能为空" }, { status: 400 });
      }
    }
    if (sortOrder !== undefined) {
      const order = Math.floor(Number(sortOrder) || 0);
      if (order < 0 || order > MAX_SORT_ORDER) {
        return NextResponse.json({ error: `排序值必须在0-${MAX_SORT_ORDER}之间` }, { status: 400 });
      }
    }

    // Use transaction for atomic read-modify-write
    const chapter = await db.$transaction(async (tx) => {
      // Get old chapter for word count diff
      const oldChapter = await tx.chapter.findUnique({ where: { id } });
      if (!oldChapter) {
        throw new Error("NOT_FOUND");
      }

      const newContent = content !== undefined
        ? sanitizeField(content, MAX_CONTENT_LENGTH)
        : oldChapter.content || "";
      const newWordCount = newContent.length;
      const wordDiff = newWordCount - (oldChapter.wordCount || 0);

      const updated = await tx.chapter.update({
        where: { id },
        data: {
          ...(title !== undefined && { title: sanitizeField(title, MAX_TITLE_LENGTH) }),
          ...(content !== undefined && { content: sanitizeField(content, MAX_CONTENT_LENGTH) || null }),
          ...(sortOrder !== undefined && { sortOrder: Math.floor(Number(sortOrder) || 0) }),
          wordCount: newWordCount,
        },
      });

      // Update novel word count atomically
      if (wordDiff !== 0) {
        await tx.novel.update({
          where: { id: oldChapter.novelId },
          data: { wordCount: { increment: wordDiff } },
        });
      }

      return updated;
    });

    return NextResponse.json(chapter);
  } catch (error) {
    if (error instanceof Error && error.message === "NOT_FOUND") {
      return NextResponse.json({ error: "章节不存在" }, { status: 404 });
    }
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

    // Use transaction for atomic delete + word count update
    await db.$transaction(async (tx) => {
      const chapter = await tx.chapter.findUnique({ where: { id } });
      if (!chapter) {
        throw new Error("NOT_FOUND");
      }

      // Update novel word count before deleting
      if (chapter.wordCount > 0) {
        await tx.novel.update({
          where: { id: chapter.novelId },
          data: { wordCount: { decrement: chapter.wordCount } },
        });
      }

      await tx.chapter.delete({ where: { id } });
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "NOT_FOUND") {
      return NextResponse.json({ error: "章节不存在" }, { status: 404 });
    }
    console.error("Delete chapter error:", error);
    return NextResponse.json({ error: "删除章节失败" }, { status: 500 });
  }
}