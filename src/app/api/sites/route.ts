import { db } from "@/lib/db";
import { parsePagination, sanitizeField, safeJson, asStringOrNull, isPrismaError, safeJsonStringify, apiError, apiSuccess } from "@/lib/api-utils";
import { NextRequest } from "next/server";
import { invalidateCache } from "@/lib/cache";
import { withAuth } from "@/lib/api-auth";
import { paginatedList } from "@/lib/crud-helpers";
import {
  MAX_NAME_LENGTH, MAX_DOMAIN_LENGTH, MAX_DESCRIPTION_LENGTH,
  MAX_SITE_TITLE_LENGTH, MAX_SITE_DESC_LENGTH, MAX_KEYWORDS_LENGTH,
  MAX_OFFSET, DOMAIN_RE,
} from "@/lib/validation/sites";
import { validateJsonObject } from "@/lib/validation/common";

// GET /api/sites - List all sites with pagination
export const GET = withAuth(async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const { page, pageSize } = parsePagination(searchParams);
    return paginatedList(db.site, {
      page,
      pageSize,
      orderBy: { createdAt: "desc" },
      include: { theme: true },
      itemsKey: 'sites',
    });
  } catch (error) {
    console.error("List sites error:", error);
    return apiError("获取站点列表失败");
  }
});

// POST /api/sites - Create a site
export const POST = withAuth(async function POST(request: NextRequest) {
  try {
    let body;
    try {
      body = await safeJson(request);
    } catch {
      return apiError("请求数据格式错误", 400);
    }
    const {
      domain,
      name,
      description,
      themeId,
      enabled,
      siteTitle,
      siteDescription,
      siteKeywords,
      geoConfig,
      novelOffset,
      chapterOffset,
      customConfig,
    } = body;

    const sanitizedDomain = sanitizeField(domain, MAX_DOMAIN_LENGTH);
    if (!sanitizedDomain) {
      return apiError("站点域名不能为空", 400);
    }
    if (!DOMAIN_RE.test(sanitizedDomain)) {
      return apiError("站点域名格式不合法，必须为有效域名（如 example.com）", 400);
    }
    const sanitizedName = sanitizeField(name, MAX_NAME_LENGTH);
    if (!sanitizedName) {
      return apiError("站点名称不能为空", 400);
    }
    const themeIdStr = asStringOrNull(themeId);
    if (themeIdStr) {
      const themeExists = await db.theme.findUnique({ where: { id: themeIdStr }, select: { id: true } });
      if (!themeExists) {
        return apiError("指定的主题不存在", 400);
      }
    }
    const geoConfigError = validateJsonObject(geoConfig, '地理配置');
    if (geoConfigError) {
      return apiError(geoConfigError, 400);
    }
    const customConfigError = validateJsonObject(customConfig, '自定义配置');
    if (customConfigError) {
      return apiError(customConfigError, 400);
    }

    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return apiError("enabled 必须是布尔值", 400);
    }

    const parsedNovelOffset = novelOffset !== undefined ? Math.min(Math.max(0, Math.floor(Number(novelOffset) || 0)), MAX_OFFSET) : 0;
    const parsedChapterOffset = chapterOffset !== undefined ? Math.min(Math.max(0, Math.floor(Number(chapterOffset) || 0)), MAX_OFFSET) : 0;

    const site = await db.site.create({
      data: {
        domain: sanitizedDomain,
        name: sanitizedName,
        description: sanitizeField(description, MAX_DESCRIPTION_LENGTH) || null,
        themeId: themeIdStr || null,
        enabled: enabled !== undefined ? enabled : true,
        siteTitle: sanitizeField(siteTitle, MAX_SITE_TITLE_LENGTH) || null,
        siteDescription: sanitizeField(siteDescription, MAX_SITE_DESC_LENGTH) || null,
        siteKeywords: sanitizeField(siteKeywords, MAX_KEYWORDS_LENGTH) || null,
        geoConfig: geoConfig ? safeJsonStringify(geoConfig, '地理配置') : null,
        novelOffset: parsedNovelOffset,
        chapterOffset: parsedChapterOffset,
        customConfig: customConfig ? safeJsonStringify(customConfig, '自定义配置') : null,
      },
      include: {
        theme: true,
      },
    });

    invalidateCache("sites:list:*");

    return apiSuccess(site, 201);
  } catch (error: unknown) {
    console.error("Create site error:", error);
    if (isPrismaError(error, "P2002")) {
      return apiError("站点域名已存在", 409);
    }
    return apiError("创建站点失败");
  }
});