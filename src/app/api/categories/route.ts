import { db } from "@/lib/db";
import { safeJson, sanitizeField, isPrismaError, apiError, apiSuccess } from "@/lib/api-utils";
import { NextRequest, NextResponse } from "next/server";
import { getOrCompute, invalidateCache } from "@/lib/cache";
import { withAuth } from "@/lib/api-auth";
import { MAX_NAME_LENGTH, MAX_SLUG_LENGTH, MAX_DESCRIPTION_LENGTH, VALID_COLOR_RE } from "@/lib/validation/categories";

// GET /api/categories - List all categories
export const GET = withAuth(async function GET() {
  try {
    const categories = await getOrCompute("categories:admin", 60_000, () =>
      db.category.findMany({
        orderBy: { sortOrder: "asc" },
        take: 500,
        include: { _count: { select: { novels: true } } },
      })
    );
    return NextResponse.json(categories);
  } catch (error) {
    console.error("List categories error:", error);
    return apiError("获取分类列表失败");
  }
});

// POST /api/categories - Create a category
export const POST = withAuth(async function POST(request: NextRequest) {
  try {
    let body;
    try {
      body = await safeJson(request);
    } catch {
      return apiError("请求数据格式错误", 400);
    }
    const { name, slug, icon, description, color, sortOrder } = body;

    if (!name?.trim()) {
      return apiError("分类名称不能为空", 400);
    }
    if (!slug?.trim()) {
      return apiError("分类标识符不能为空", 400);
    }
    if (!/^[a-z0-9_-]+$/.test(slug.trim())) {
      return apiError("分类标识符只能包含小写字母、数字、下划线和连字符", 400);
    }
    if (slug.trim().length > MAX_SLUG_LENGTH) {
      return apiError(`分类标识符不能超过${MAX_SLUG_LENGTH}个字符`, 400);
    }
    if (name.trim().length > MAX_NAME_LENGTH) {
      return apiError(`分类名称不能超过${MAX_NAME_LENGTH}个字符`, 400);
    }
    if (description && typeof description === "string" && description.trim().length > MAX_DESCRIPTION_LENGTH) {
      return apiError(`分类描述不能超过${MAX_DESCRIPTION_LENGTH}个字符`, 400);
    }
    if (color && !VALID_COLOR_RE.test(color)) {
      return apiError("颜色格式无效，请使用HEX格式（如#6b7280）", 400);
    }

    const category = await db.category.create({
      data: {
        name: sanitizeField(name, MAX_NAME_LENGTH),
        slug: slug.trim(),
        icon: icon?.trim() || null,
        description: sanitizeField(description, MAX_DESCRIPTION_LENGTH) || null,
        color: color || "#6b7280",
        sortOrder: Math.max(0, Math.floor(Number(sortOrder) || 0)),
      },
      include: { _count: { select: { novels: true } } },
    });

    invalidateCache("dashboard:stats");
    invalidateCache("categories:*");

    return NextResponse.json(category, { status: 201 });
  } catch (error: unknown) {
    console.error("Create category error:", error);
    if (isPrismaError(error, "P2002")) {
      return apiError("分类名称或标识符已存在", 409);
    }
    return apiError("创建分类失败");
  }
});