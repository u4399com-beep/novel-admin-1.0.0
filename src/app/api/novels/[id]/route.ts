import { db } from "@/lib/db";
import { isSafeUrl } from "@/lib/sanitize";
import { NextRequest, NextResponse } from "next/server";

const VALID_STATUSES = ["ongoing", "completed", "hiatus"];

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

    if (status !== undefined && !VALID_STATUSES.includes(status)) {
      return NextResponse.json({ error: "无效的小说状态" }, { status: 400 });
    }

    // Validate categoryId existence if provided
    if (categoryId !== undefined && categoryId) {
      const categoryExists = await db.category.findUnique({ where: { id: categoryId } });
      if (!categoryExists) {
        return NextResponse.json({ error: "指定的分类不存在" }, { status: 400 });
      }
    }

    // Validate tag IDs existence if provided
    if (tags !== undefined && Array.isArray(tags)) {
      const tagCount = await db.tag.count({
        where: { id: { in: tags } },
      });
      if (tagCount !== tags.length) {
        return NextResponse.json({ error: "部分标签ID不存在" }, { status: 400 });
      }
    }

    // Validate coverUrl protocol
    if (coverUrl !== undefined && coverUrl && !isSafeUrl(coverUrl)) {
      return NextResponse.json({ error: "封面URL格式不合法，仅允许http/https协议" }, { status: 400 });
    }

    // Use transaction for atomic tag update
    const novel = await db.$transaction(async (tx) => {
      // If tags are provided, delete old ones atomically with the update
      if (tags !== undefined) {
        await tx.novelTag.deleteMany({ where: { novelId: id } });
      }

      return tx.novel.update({
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