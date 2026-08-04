import { db } from "@/lib/db";
import { safeJson, sanitizeField, isPrismaError, apiError } from "@/lib/api-utils";
import { NextRequest, NextResponse } from "next/server";
import { getOrCompute, invalidateCache } from "@/lib/cache";
import { withAuth } from "@/lib/api-auth";
import { MAX_NAME_LENGTH, VALID_COLOR_RE } from "@/lib/validation/tags";

// GET /api/tags - List all tags
export const GET = withAuth(async function GET() {
  try {
    const tags = await getOrCompute("tags:list", 60_000, () =>
      db.tag.findMany({
        orderBy: { createdAt: "desc" },
        take: 500,
        include: { _count: { select: { novels: true } } },
      })
    );
    return NextResponse.json(tags);
  } catch (error) {
    console.error("List tags error:", error);
    return apiError("获取标签列表失败");
  }
});

// POST /api/tags - Create a tag
export const POST = withAuth(async function POST(request: NextRequest) {
  try {
    let body;
    try {
      body = await safeJson(request);
    } catch {
      return apiError("请求数据格式错误", 400);
    }
    const { name, color } = body;

    if (!name?.trim()) {
      return apiError("标签名称不能为空", 400);
    }
    if (name.trim().length > MAX_NAME_LENGTH) {
      return apiError(`标签名称不能超过${MAX_NAME_LENGTH}个字符`, 400);
    }
    if (color && !VALID_COLOR_RE.test(color)) {
      return apiError("颜色格式无效，请使用HEX格式（如#6b7280）", 400);
    }

    const tag = await db.tag.create({
      data: {
        name: sanitizeField(name, MAX_NAME_LENGTH),
        color: color || "#6b7280",
      },
      include: { _count: { select: { novels: true } } },
    });

    invalidateCache("tags:list");
    invalidateCache("dashboard:stats");

    return NextResponse.json(tag, { status: 201 });
  } catch (error: unknown) {
    console.error("Create tag error:", error);
    if (isPrismaError(error, "P2002")) {
      return apiError("标签名称已存在", 409);
    }
    return apiError("创建标签失败");
  }
});