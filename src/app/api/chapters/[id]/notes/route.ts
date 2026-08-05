import { db } from "@/lib/db";
import { sanitizeField } from "@/lib/api-utils";
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
      return NextResponse.json({ error: "章节不存在" }, { status: 404 });
    }

    const notes = await db.readingNote.findMany({
      where: { chapterId: id },
      orderBy: { position: "asc" },
    });

    return NextResponse.json(notes);
  } catch (err) {
    console.error("Failed to fetch notes:", err);
    return NextResponse.json({ error: "获取笔记失败" }, { status: 500 });
  }
});

// POST /api/chapters/[id]/notes - Create a note
export const POST = withAuth(async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { content, position } = body;

    // Validate
    if (typeof content !== "string" || content.trim().length === 0) {
      return NextResponse.json({ error: "笔记内容不能为空" }, { status: 400 });
    }

    if (content.length > 5000) {
      return NextResponse.json({ error: "笔记内容不能超过5000个字符" }, { status: 400 });
    }

    if (typeof position !== "number" || position < 0 || position > 100000) {
      return NextResponse.json({ error: "位置参数无效，必须在0-100000之间" }, { status: 400 });
    }

    // Verify chapter exists
    const chapter = await db.chapter.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!chapter) {
      return NextResponse.json({ error: "章节不存在" }, { status: 404 });
    }

    const note = await db.readingNote.create({
      data: {
        chapterId: id,
        content: sanitizeField(content.trim()),
        position: Math.round(position),
      },
    });

    return NextResponse.json(note, { status: 201 });
  } catch (err) {
    console.error("Failed to create note:", err);
    return NextResponse.json({ error: "创建笔记失败" }, { status: 500 });
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
      return NextResponse.json({ error: "缺少 noteId 参数" }, { status: 400 });
    }

    // Verify note exists and belongs to this chapter
    const existing = await db.readingNote.findFirst({
      where: { id: noteId, chapterId: id },
    });

    if (!existing) {
      return NextResponse.json({ error: "笔记不存在" }, { status: 404 });
    }

    await db.readingNote.delete({
      where: { id: noteId },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Failed to delete note:", err);
    return NextResponse.json({ error: "删除笔记失败" }, { status: 500 });
  }
});
