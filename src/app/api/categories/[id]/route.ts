import { db } from "@/lib/db";
import { safeJson, sanitizeField, isPrismaError, apiError } from "@/lib/api-utils";
import { NextRequest, NextResponse } from "next/server";
import { invalidateCache } from "@/lib/cache";
import { withAuth } from "@/lib/api-auth";
import { getOrFail, NotFoundError } from "@/lib/crud-helpers";
import { MAX_NAME_LENGTH, MAX_SLUG_LENGTH, MAX_DESCRIPTION_LENGTH, VALID_COLOR_RE } from "@/lib/validation/categories";

// GET /api/categories/[id] - Get a single category
export const GET = withAuth(async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await getOrFail(db.category, { id }, '分类不存在');
    const category = await db.category.findUnique({
      where: { id },
      include: { _count: { select: { novels: true } } },
    });
    return NextResponse.json(category!);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return apiError(error.message, 404);
    }
    console.error("Get category error:", error);
    return apiError("获取分类详情失败");
  }
});

// PUT /api/categories/[id] - Update a category
export const PUT = withAuth(async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await getOrFail(db.category, { id }, '分类不存在');

    let body;
    try {
      body = await safeJson(request);
    } catch {
      return apiError("请求数据格式错误", 400);
    }
    const { name, slug, icon, description, color, sortOrder } = body;

    if (name !== undefined && !name?.trim()) {
      return apiError("分类名称不能为空", 400);
    }
    if (slug !== undefined && !slug?.trim()) {
      return apiError("分类标识符不能为空", 400);
    }
    if (slug !== undefined && slug.trim() && !/^[a-z0-9_-]+$/.test(slug.trim())) {
      return apiError("分类标识符只能包含小写字母、数字、下划线和连字符", 400);
    }
    if (slug !== undefined && slug.trim().length > MAX_SLUG_LENGTH) {
      return apiError(`分类标识符不能超过${MAX_SLUG_LENGTH}个字符`, 400);
    }
    if (name !== undefined && name.trim().length > MAX_NAME_LENGTH) {
      return apiError(`分类名称不能超过${MAX_NAME_LENGTH}个字符`, 400);
    }
    if (description !== undefined && typeof description === "string" && description.trim().length > MAX_DESCRIPTION_LENGTH) {
      return apiError(`分类描述不能超过${MAX_DESCRIPTION_LENGTH}个字符`, 400);
    }
    if (color !== undefined && color && !VALID_COLOR_RE.test(color)) {
      return apiError("颜色格式无效，请使用HEX格式（如#6b7280）", 400);
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
    if (error instanceof NotFoundError) {
      return apiError(error.message, 404);
    }
    console.error("Update category error:", error);
    if (isPrismaError(error, "P2002")) {
      return apiError("分类名称或标识符已存在", 409);
    }
    if (isPrismaError(error, "P2025")) {
      return apiError("分类不存在", 404);
    }
    return apiError("更新分类失败");
  }
});

// DELETE /api/categories/[id] - Delete a category (RESTful path parameter)
export const DELETE = withAuth(async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await getOrFail(db.category, { id }, '分类不存在');

    const novelCount = await db.novel.count({ where: { categoryId: id } });
    if (novelCount > 0) {
      return apiError(`无法删除：有 ${novelCount} 本小说正在使用此分类`, 409);
    }

    await db.category.delete({ where: { id } });
    invalidateCache("dashboard:stats");
    invalidateCache("categories:*");
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    if (error instanceof NotFoundError) {
      return apiError(error.message, 404);
    }
    console.error("Delete category error:", error);
    if (isPrismaError(error, "P2025")) {
      return apiError("分类不存在", 404);
    }
    if (isPrismaError(error, "P2003")) {
      return apiError("无法删除：有小说正在使用此分类", 409);
    }
    return apiError("删除分类失败");
  }
});
