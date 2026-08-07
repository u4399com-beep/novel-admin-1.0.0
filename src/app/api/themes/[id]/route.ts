import { db } from "@/lib/db";
import { safeJson, sanitizeField, isPrismaError, apiError, apiDeleted } from "@/lib/api-utils";
import { NextRequest, NextResponse } from "next/server";
import { invalidateCache } from "@/lib/cache";
import { withAuth } from "@/lib/api-auth";
import { getOrFail, NotFoundError } from "@/lib/crud-helpers";
import { VALID_IDENTIFIER_RE, MAX_NAME_LENGTH, MAX_DESCRIPTION_LENGTH, MAX_IDENTIFIER_LENGTH, MAX_CONFIG_SIZE } from "@/lib/validation/themes";

// GET /api/themes/[id] - Get a single theme
export const GET = withAuth(async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const theme = await db.theme.findUniqueOrThrow({
      where: { id },
      include: {
        _count: { select: { sites: true } },
      },
    });
    return NextResponse.json(theme);
  } catch (error) {
    if (isPrismaError(error, 'P2025')) {
      return apiError('主题不存在', 404);
    }
    console.error("Get theme error:", error);
    return apiError("获取主题详情失败");
  }
});

// PUT /api/themes/[id] - Update a theme
export const PUT = withAuth(async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await getOrFail(db.theme, { id }, '主题不存在');

    let body;
    try {
      body = await safeJson(request);
    } catch {
      return apiError("请求数据格式错误", 400);
    }
    const { name, description, identifier, preview, config, enabled } = body;

    if (name !== undefined && !name?.trim()) {
      return apiError("主题名称不能为空", 400);
    }
    if (name !== undefined && name.trim().length > MAX_NAME_LENGTH) {
      return apiError(`主题名称不能超过${MAX_NAME_LENGTH}个字符`, 400);
    }
    if (identifier !== undefined) {
      if (typeof identifier !== 'string' || !identifier.trim()) {
        return apiError("主题标识符不能为空", 400);
      }
      if (!VALID_IDENTIFIER_RE.test(identifier.trim())) {
        return apiError("主题标识符只能包含字母、数字、下划线和短横线", 400);
      }
      if (identifier.trim().length > MAX_IDENTIFIER_LENGTH) {
        return apiError(`主题标识符不能超过${MAX_IDENTIFIER_LENGTH}个字符`, 400);
      }
    }
    if (description !== undefined && typeof description === "string" && description.trim().length > MAX_DESCRIPTION_LENGTH) {
      return apiError(`主题描述不能超过${MAX_DESCRIPTION_LENGTH}个字符`, 400);
    }
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return apiError("enabled 必须是布尔值", 400);
    }
    let configStr: string | undefined;
    if (config !== undefined) {
      configStr = typeof config === "string" ? config : JSON.stringify(config);
      if (configStr.length > MAX_CONFIG_SIZE) {
        return apiError(`主题配置大小不能超过${Math.floor(MAX_CONFIG_SIZE / 1024)}KB`, 400);
      }
      try {
        JSON.parse(configStr);
      } catch {
        return apiError("主题配置必须是合法的JSON", 400);
      }
    }

    const theme = await db.theme.update({
      where: { id },
      data: {
        ...(name !== undefined && { name: sanitizeField(name, MAX_NAME_LENGTH) }),
        ...(description !== undefined && { description: sanitizeField(description, MAX_DESCRIPTION_LENGTH) || null }),
        ...(identifier !== undefined && { identifier: sanitizeField(identifier, MAX_IDENTIFIER_LENGTH) }),
        ...(preview !== undefined && { preview: sanitizeField(preview, 500) || null }),
        ...(config !== undefined && { config: configStr }),
        ...(enabled !== undefined && { enabled }),
      },
      include: {
        _count: { select: { sites: true } },
      },
    });

    invalidateCache("themes:list");

    return NextResponse.json(theme);
  } catch (error: unknown) {
    if (error instanceof NotFoundError) {
      return apiError(error.message, 404);
    }
    console.error("Update theme error:", error);
    if (isPrismaError(error, "P2002")) {
      return apiError("主题名称或标识符已存在", 409);
    }
    if (isPrismaError(error, "P2025")) {
      return apiError("主题不存在", 404);
    }
    return apiError("更新主题失败");
  }
});

// DELETE /api/themes/[id] - Delete a theme
export const DELETE = withAuth(async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await db.$transaction(async (tx) => {
      await getOrFail(tx.theme, { id }, '主题不存在');
      const siteCount = await tx.site.count({ where: { themeId: id } });
      if (siteCount > 0) {
        throw new Error(`HAS_SITES:${siteCount}`);
      }
      await tx.theme.delete({ where: { id } });
    });
    invalidateCache("themes:list");
    return apiDeleted();
  } catch (error: unknown) {
    if (error instanceof NotFoundError) {
      return apiError(error.message, 404);
    }
    if (error instanceof Error && error.message.startsWith('HAS_SITES:')) {
      const count = error.message.split(':')[1];
      return apiError(`无法删除：有 ${count} 个站点正在使用此主题`, 409);
    }
    console.error("Delete theme error:", error);
    if (isPrismaError(error, "P2025")) {
      return apiError("主题不存在", 404);
    }
    return apiError("删除主题失败");
  }
});
