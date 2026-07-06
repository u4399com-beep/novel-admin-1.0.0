import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

// GET /api/novels/[id] - Get a single novel
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const novel = await db.novel.findUnique({
      where: { id },
      include: {
        category: true,
        tags: { include: { tag: true } },
        _count: { select: { chapters: true } },
      },
    });

    if (!novel) {
      return NextResponse.json({ error: "小说不存在" }, { status: 404 });
    }

    return NextResponse.json(novel);
  } catch (error) {
    console.error("Get novel error:", error);
    return NextResponse.json({ error: "获取小说详情失败" }, { status: 500 });
  }
}

// PUT /api/novels/[id] - Update a novel
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { title, author, description, coverUrl, status, categoryId, tags } = body;

    if (title !== undefined && !title?.trim()) {
      return NextResponse.json({ error: "小说标题不能为空" }, { status: 400 });
    }

    const validStatuses = ["ongoing", "completed", "hiatus"];
    if (status !== undefined && !validStatuses.includes(status)) {
      return NextResponse.json({ error: "无效的小说状态" }, { status: 400 });
    }

    // If tags are provided, delete old ones and create new ones
    if (tags !== undefined) {
      await db.novelTag.deleteMany({ where: { novelId: id } });
    }

    const novel = await db.novel.update({
      where: { id },
      data: {
        ...(title !== undefined && { title: title.trim().slice(0, 200) }),
        ...(author !== undefined && { author: (author?.trim() || "佚名").slice(0, 100) }),
        ...(description !== undefined && { description: description?.trim()?.slice(0, 5000) || null }),
        ...(coverUrl !== undefined && { coverUrl: coverUrl || null }),
        ...(status !== undefined && { status }),
        ...(categoryId !== undefined && { categoryId: categoryId || null }),
        ...(tags !== undefined && {
          tags: tags.length
            ? {
                create: tags.map((tagId: string) => ({ tagId })),
              }
            : undefined,
        }),
      },
      include: {
        category: true,
        tags: { include: { tag: true } },
        _count: { select: { chapters: true } },
      },
    });

    return NextResponse.json(novel);
  } catch (error) {
    console.error("Update novel error:", error);
    return NextResponse.json({ error: "更新小说失败" }, { status: 500 });
  }
}

// DELETE /api/novels/[id] - Delete a novel
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await db.novel.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Delete novel error:", error);
    return NextResponse.json({ error: "删除小说失败" }, { status: 500 });
  }
}