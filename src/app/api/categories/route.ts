import { db } from "@/lib/db";
import { parsePagination, safeJson, sanitizeField, isPrismaError, apiError, apiSuccess } from "@/lib/api-utils";
import { NextRequest } from "next/server";
import { invalidateCache } from "@/lib/cache";
import { withAuth } from "@/lib/api-auth";
import { paginatedList, requireFields } from "@/lib/crud-helpers";
import { MAX_NAME_LENGTH, MAX_SLUG_LENGTH, MAX_DESCRIPTION_LENGTH, VALID_COLOR_RE } from "@/lib/validation/categories";

// GET /api/categories - List all categories with pagination
export const GET = withAuth(async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const { page, pageSize } = parsePagination(searchParams);
    return paginatedList(db.category, {
      page,
      pageSize,
      orderBy: { sortOrder: "asc" },
      include: { _count: { select: { novels: true } } },
      itemsKey: 'categories',
    });
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

    const check = requireFields(body, ['name', 'slug']);
    if (!check.valid) return check.response;

    const { name, slug, icon, description, color, sortOrder } = body;

    if (typeof slug !== 'string' || !/^[a-z0-9_-]+$/.test(slug.trim())) {
      return apiError("分类标识符必须是字符串且只能包含小写字母、数字、下划线和连字符", 400);
    }
    if (slug.trim().length > MAX_SLUG_LENGTH) {
      return apiError(`分类标识符不能超过${MAX_SLUG_LENGTH}个字符`, 400);
    }
    if (typeof name !== 'string' || name.trim().length > MAX_NAME_LENGTH) {
      return apiError(`分类名称必须是字符串且不能超过${MAX_NAME_LENGTH}个字符`, 400);
    }
    if (description && typeof description === "string" && description.trim().length > MAX_DESCRIPTION_LENGTH) {
      return apiError(`分类描述不能超过${MAX_DESCRIPTION_LENGTH}个字符`, 400);
    }
    if (color && (typeof color !== 'string' || !VALID_COLOR_RE.test(color))) {
      return apiError("颜色格式无效，请使用HEX格式（如#6b7280）", 400);
    }

    const category = await db.category.create({
      data: {
        name: sanitizeField(name, MAX_NAME_LENGTH),
        slug: sanitizeField(slug, MAX_SLUG_LENGTH) || '',
        icon: typeof icon === 'string' && icon.trim() ? icon.trim() : null,
        description: sanitizeField(description, MAX_DESCRIPTION_LENGTH) || null,
        color: typeof color === 'string' && color ? color : "#6b7280",
        sortOrder: Math.max(0, Math.floor(Number(sortOrder) || 0)),
      },
      include: { _count: { select: { novels: true } } },
    });

    invalidateCache("dashboard:stats");
    invalidateCache("categories:*");

    return apiSuccess(category, 201);
  } catch (error: unknown) {
    console.error("Create category error:", error);
    if (isPrismaError(error, "P2002")) {
      return apiError("分类名称或标识符已存在", 409);
    }
    return apiError("创建分类失败");
  }
});
