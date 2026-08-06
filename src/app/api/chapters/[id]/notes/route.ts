import { db } from "@/lib/db";
import { sanitizeField, apiError, safeJson } from "@/lib/api-utils";
import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";

// GET /api/chapters/[id]/notes - List notes for a chapter
export const GET = withAuth(async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // Verify chapter exists
    const chapter = await db.chapter.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!chapter) {
      return apiError("章节不存在", 404);
    }

    const notes = await db.readingNote.findMany({
      where: { chapterId: id },
      orderBy: { position: "asc" },
    });

    return NextResponse.json(notes);
  } catch (err) {
    console.error("Failed to fetch notes:", err);
    return apiError("获取笔记失败", 500);
  }
});

// POST /api/chapters/[id]/notes - Create a note
export const POST = withAuth(async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    let body;
    try {
      body = await safeJson(request);
    } catch {
      return apiError('请求数据格式错误', 400);
    }
    const { content, position } = body;

    // Validate
    if (typeof content !== "string" || content.trim().length === 0) {
      return apiError("笔记内容不能为空", 400);
    }

    if (content.length > 5000) {
      return apiError("笔记内容不能超过5000个字符", 400);
    }

    if (typeof position !== "number" || position < 0 || position > 100000) {
      return apiError("位置参数无效，必须在0-100000之间", 400);
    }

    // Verify chapter exists
    const chapter = await db.chapter.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!chapter) {
      return apiError("章节不存在", 404);
    }

    const note = await db.readingNote.create({
      data: {
        chapterId: id,
        content: sanitizeField(content.trim(), 5000),
        position: Math.round(position),
      },
    });

    return NextResponse.json(note, { status: 201 });
  } catch (err) {
    console.error("Failed to create note:", err);
    return apiError("创建笔记失败", 500);
  }
});

// DELETE /api/chapters/[id]/notes?noteId=xxx - Delete a note
export const DELETE = withAuth(async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const noteId = searchParams.get("noteId");

    if (!noteId) {
      return apiError("缺少 noteId 参数", 400);
    }

    // Verify note exists and belongs to this chapter
    const existing = await db.readingNote.findFirst({
      where: { id: noteId, chapterId: id },
    });

    if (!existing) {
      return apiError("笔记不存在", 404);
    }

    await db.readingNote.delete({
      where: { id: noteId },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Failed to delete note:", err);
    return apiError("删除笔记失败", 500);
  }
});
