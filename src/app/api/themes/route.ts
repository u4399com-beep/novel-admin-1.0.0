import { db } from "@/lib/db";
import { parsePagination, safeJson, sanitizeField, isPrismaError, apiError, apiSuccess } from "@/lib/api-utils";
import { NextRequest } from "next/server";
import { invalidateCache } from "@/lib/cache";
import { withAuth } from "@/lib/api-auth";
import { paginatedList, requireFields } from "@/lib/crud-helpers";
import { VALID_IDENTIFIER_RE, MAX_NAME_LENGTH, MAX_DESCRIPTION_LENGTH, MAX_IDENTIFIER_LENGTH, MAX_CONFIG_SIZE } from "@/lib/validation/themes";

// GET /api/themes - List all themes with pagination
export const GET = withAuth(async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const { page, pageSize } = parsePagination(searchParams);
    return paginatedList(db.theme, {
      page,
      pageSize,
      orderBy: { createdAt: "desc" },
      include: {
        _count: { select: { sites: true } },
      },
      itemsKey: 'themes',
    });
  } catch (error) {
    console.error("List themes error:", error);
    return apiError("获取主题列表失败");
  }
});

// POST /api/themes - Create a theme
export const POST = withAuth(async function POST(request: NextRequest) {
  try {
    let body;
    try {
      body = await safeJson(request);
    } catch {
      return apiError("请求数据格式错误", 400);
    }

    const check = requireFields(body, ['name', 'identifier', 'config']);
    if (!check.valid) return check.response;

    const { name, description, identifier, preview, config, enabled } = body;

    if (typeof name !== 'string' || name.trim().length > MAX_NAME_LENGTH) {
      return apiError(`主题名称必须是字符串且不能超过${MAX_NAME_LENGTH}个字符`, 400);
    }
    if (typeof identifier !== 'string') {
      return apiError("主题标识符必须是字符串", 400);
    }
    if (!VALID_IDENTIFIER_RE.test(identifier.trim())) {
      return apiError("主题标识符只能包含字母、数字、下划线和短横线", 400);
    }
    if (identifier.trim().length > MAX_IDENTIFIER_LENGTH) {
      return apiError(`主题标识符不能超过${MAX_IDENTIFIER_LENGTH}个字符`, 400);
    }
    if (description && typeof description === "string" && description.trim().length > MAX_DESCRIPTION_LENGTH) {
      return apiError(`主题描述不能超过${MAX_DESCRIPTION_LENGTH}个字符`, 400);
    }
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return apiError("enabled 必须是布尔值", 400);
    }

    const configStr = typeof config === "string" ? config : JSON.stringify(config);
    if (configStr.length > MAX_CONFIG_SIZE) {
      return apiError(`主题配置大小不能超过${Math.floor(MAX_CONFIG_SIZE / 1024)}KB`, 400);
    }
    try {
      JSON.parse(configStr);
    } catch {
      return apiError("主题配置必须是合法的JSON", 400);
    }

    const theme = await db.theme.create({
      data: {
        name: sanitizeField(name, MAX_NAME_LENGTH),
        description: sanitizeField(description, MAX_DESCRIPTION_LENGTH) || null,
        identifier: sanitizeField(identifier, MAX_IDENTIFIER_LENGTH),
        preview: sanitizeField(preview, 500) || null,
        config: (() => {
          try {
            return JSON.stringify(typeof config === "string" ? JSON.parse(config) : config);
          } catch {
            return JSON.stringify(config);
          }
        })(),
        enabled: typeof enabled === 'boolean' ? enabled : true,
      },
      include: {
        _count: { select: { sites: true } },
      },
    });

    invalidateCache("themes:list");

    return apiSuccess(theme, 201);
  } catch (error: unknown) {
    console.error("Create theme error:", error);
    if (isPrismaError(error, "P2002")) {
      return apiError("主题名称或标识符已存在", 409);
    }
    return apiError("创建主题失败");
  }
});
