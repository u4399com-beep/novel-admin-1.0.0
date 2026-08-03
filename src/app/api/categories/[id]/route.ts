import { db } from "@/lib/db";
import { safeJson, sanitizeField, isPrismaError } from "@/lib/api-utils";
import { NextRequest, NextResponse } from "next/server";
import { invalidateCache } from "@/lib/cache";
import { withAuth } from "@/lib/api-auth";
import { MAX_NAME_LENGTH, MAX_SLUG_LENGTH, MAX_DESCRIPTION_LENGTH, VALID_COLOR_RE } from "@/lib/validation/categories";

// GET /api/categories/[id] - Get a single category
export const GET = withAuth(async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const category = await db.category.findUnique({
      where: { id },
      include: { _count: { select: { novels: true } } },
    });

    if (!category) {
      return NextResponse.json({ error: "分类不存在" }, { status: 404 });
    }

    return NextResponse.json(category);
  } catch (error) {
    console.error("Get category error:", error);
    return NextResponse.json({ error: "获取分类详情失败"}, { status: 500 });
  }
});

// PUT /api/categories/[id] - Update a category
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
    const { name, slug, icon, description, color, sortOrder } = body;

    if (name !== undefined && !name?.trim()) {
      return NextResponse.json({ error: "分类名称不能为空" }, { status: 400 });
    }
    if (slug !== undefined && !slug?.trim()) {
      return NextResponse.json({ error: "分类标识符不能为空" }, { status: 400 });
    }
    if (slug !== undefined && slug.trim() && !/^[a-z0-9_-]+$/.test(slug.trim())) {
      return NextResponse.json({ error: "分类标识符只能包含小写字母、数字、下划线和连字符" }, { status: 400 });
    }
    if (slug !== undefined && slug.trim().length > MAX_SLUG_LENGTH) {
      return NextResponse.json({ error: `分类标识符不能超过${MAX_SLUG_LENGTH}个字符` }, { status: 400 });
    }
    if (name !== undefined && name.trim().length > MAX_NAME_LENGTH) {
      return NextResponse.json({ error: `分类名称不能超过${MAX_NAME_LENGTH}个字符` }, { status: 400 });
    }
    if (description !== undefined && typeof description === "string" && description.trim().length > MAX_DESCRIPTION_LENGTH) {
      return NextResponse.json({ error: `分类描述不能超过${MAX_DESCRIPTION_LENGTH}个字符` }, { status: 400 });
    }
    if (color !== undefined && color && !VALID_COLOR_RE.test(color)) {
      return NextResponse.json({ error: "颜色格式无效，请使用HEX格式（如#6b7280）" }, { status: 400 });
    }

    const category = await db.category.update({
      where: { id },
      data: {
        ...(name !== undefined && { name: sanitizeField(name, MAX_NAME_LENGTH) }),
        ...(slug !== undefined && { slug: slug.trim() }),
        ...(icon !== undefined && { icon: icon?.trim() || null }),
        ...(description !== undefined && { description: sanitizeField(description, MAX_DESCRIPTION_LENGTH) || null }),
        ...(color !== undefined && { color: color || "#6b7280" }),
        ...(sortOrder !== undefined && { sortOrder: Math.max(0, Math.floor(Number(sortOrder) || 0)) }),
      },
      include: { _count: { select: { novels: true } } },
    });

    invalidateCache("dashboard:stats");
    invalidateCache("categories:*");

    return NextResponse.json(category);
  } catch (error: unknown) {
    console.error("Update category error:", error);
    if (isPrismaError(error, "P2002")) {
      return NextResponse.json({ error: "分类名称或标识符已存在" }, { status: 409 });
    }
    if (isPrismaError(error, "P2025")) {
      return NextResponse.json({ error: "分类不存在" }, { status: 404 });
    }
    return NextResponse.json({ error: "更新分类失败"}, { status: 500 });
  }
});

// DELETE /api/categories/[id] - Delete a category (RESTful path parameter)
export const DELETE = withAuth(async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const existing = await db.category.findUnique({
      where: { id },
      include: { _count: { select: { novels: true } } },
    });
    if (!existing) {
      return NextResponse.json({ error: "分类不存在" }, { status: 404 });
    }
    if (existing._count.novels > 0) {
      return NextResponse.json(
        { error: `无法删除：有 ${existing._count.novels} 本小说正在使用此分类` },
        { status: 409 }
      );
    }

    await db.category.delete({ where: { id } });
    invalidateCache("dashboard:stats");
    invalidateCache("categories:*");
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    console.error("Delete category error:", error);
    if (isPrismaError(error, "P2025")) {
      return NextResponse.json({ error: "分类不存在" }, { status: 404 });
    }
    if (isPrismaError(error, "P2003")) {
      return NextResponse.json({ error: "无法删除：有小说正在使用此分类" }, { status: 409 });
    }
    return NextResponse.json({ error: "删除分类失败"}, { status: 500 });
  }
});