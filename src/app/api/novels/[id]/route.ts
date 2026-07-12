import { db } from "@/lib/db";
import { sanitizeField, safeJson } from "@/lib/api-utils";
import { isSafeUrl } from "@/lib/sanitize";
import { invalidateCache } from "@/lib/cache";
import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";

const VALID_STATUSES = ["ongoing", "completed", "hiatus"];

// GET /api/novels/[id] - Get a single novel
export const GET = withAuth(async function GET(
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
});

// PUT /api/novels/[id] - Update a novel
export const PUT = withAuth(async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    let body;
    try {
      body = await safeJson(request);
    } catch {
      return NextResponse.json({ error: "请求数据格式错误" }, { status: 400 });
    }
    const { title, author, description, coverUrl, status, categoryId, tags } = body;

    if (tags !== undefined && (!Array.isArray(tags) || !tags.every((t: unknown) => typeof t === 'string'))) {
      return NextResponse.json({ error: "标签格式错误，必须是字符串ID数组" }, { status: 400 });
    }

    if (title !== undefined) {
      const trimmedTitle = sanitizeField(title, 200);
      if (!trimmedTitle) {
        return NextResponse.json({ error: "小说标题不能为空" }, { status: 400 });
      }
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

    // Validate sourceUrl protocol (SSRF protection)
    if (body.sourceUrl !== undefined && body.sourceUrl && !isSafeUrl(body.sourceUrl)) {
      return NextResponse.json({ error: "来源URL格式不合法，仅允许http/https协议" }, { status: 400 });
    }

    // Validate coverPath to prevent path traversal
    if (body.coverPath !== undefined && body.coverPath) {
      const cp = String(body.coverPath);
      if (cp.includes('..') || !cp.startsWith('/covers/') && !cp.startsWith('/app/public/covers/')) {
        return NextResponse.json({ error: "封面路径格式不合法" }, { status: 400 });
      }
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
          ...(title !== undefined && { title: sanitizeField(title, 200) }),
          ...(author !== undefined && { author: sanitizeField(author, 100) || "佚名" }),
          ...(description !== undefined && { description: sanitizeField(description, 5000) || null }),
          ...(coverUrl !== undefined && { coverUrl: sanitizeField(coverUrl, 2048) || null }),
          ...(status !== undefined && { status }),
          ...(categoryId !== undefined && { categoryId: categoryId || null }),
          ...(body.sourceUrl !== undefined && { sourceUrl: sanitizeField(body.sourceUrl, 2048) || null }),
          ...(body.coverPath !== undefined && { coverPath: body.coverPath ? String(body.coverPath) : null }),
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

    invalidateCache("dashboard:stats");

    return NextResponse.json(novel);
  } catch (error) {
    console.error("Update novel error:", error);
    return NextResponse.json({ error: "更新小说失败" }, { status: 500 });
  }
});

// DELETE /api/novels/[id] - Delete a novel
export const DELETE = withAuth(async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const existing = await db.novel.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "小说不存在" }, { status: 404 });
    }
    await db.novel.delete({ where: { id } });
    invalidateCache("dashboard:stats");
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    console.error("Delete novel error:", error);
    if (error && typeof error === "object" && "code" in error && (error as { code: string }).code === "P2025") {
      return NextResponse.json({ error: "小说不存在" }, { status: 404 });
    }
    return NextResponse.json({ error: "删除小说失败" }, { status: 500 });
  }
});