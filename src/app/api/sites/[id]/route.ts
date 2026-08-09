import { db } from "@/lib/db";
import { sanitizeField, safeJson, safeJsonStringify, isPrismaError, apiError, apiDeleted } from "@/lib/api-utils";
import { NextRequest, NextResponse } from "next/server";
import { invalidateCache } from "@/lib/cache";
import { withAuth } from "@/lib/api-auth";
import {
  MAX_NAME_LENGTH, MAX_DOMAIN_LENGTH, MAX_DESCRIPTION_LENGTH,
  MAX_SITE_TITLE_LENGTH, MAX_SITE_DESC_LENGTH, MAX_KEYWORDS_LENGTH,
  MAX_OFFSET, DOMAIN_RE,
} from "@/lib/validation/sites";
import { validateJsonObject } from "@/lib/validation/common";

// GET /api/sites/[id] - Get a single site
export const GET = withAuth(async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const site = await db.site.findUnique({
      where: { id },
      include: {
        theme: true,
      },
    });

    if (!site) {
      return apiError("站点不存在", 404);
    }

    return NextResponse.json(site);
  } catch (error) {
    console.error("Get site error:", error);
    return apiError("获取站点详情失败");
  }
});

// PUT /api/sites/[id] - Update a site
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

    if (domain !== undefined) {
      const sanitizedDomain = sanitizeField(domain, MAX_DOMAIN_LENGTH);
      if (!sanitizedDomain) {
        return apiError("站点域名不能为空", 400);
      }
      if (!DOMAIN_RE.test(sanitizedDomain)) {
        return apiError("站点域名格式不合法", 400);
      }
    }
    if (name !== undefined) {
      const sanitizedName = sanitizeField(name, MAX_NAME_LENGTH);
      if (!sanitizedName) {
        return apiError("站点名称不能为空", 400);
      }
    }
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return apiError("enabled 必须是布尔值", 400);
    }
    if (themeId !== undefined && themeId) {
      const themeExists = await db.theme.findUnique({ where: { id: themeId }, select: { id: true } });
      if (!themeExists) {
        return apiError("指定的主题不存在", 400);
      }
    }
    const parsedNovelOffset = novelOffset !== undefined ? Math.min(Math.max(0, Math.floor(Number(novelOffset) || 0)), MAX_OFFSET) : undefined;
    const parsedChapterOffset = chapterOffset !== undefined ? Math.min(Math.max(0, Math.floor(Number(chapterOffset) || 0)), MAX_OFFSET) : undefined;

    if (geoConfig !== undefined) {
      const geoConfigError = validateJsonObject(geoConfig, '地理配置');
      if (geoConfigError) {
        return apiError(geoConfigError, 400);
      }
    }
    if (customConfig !== undefined) {
      const customConfigError = validateJsonObject(customConfig, '自定义配置');
      if (customConfigError) {
        return apiError(customConfigError, 400);
      }
    }

    const site = await db.site.update({
      where: { id },
      data: {
        ...(domain !== undefined && { domain: sanitizeField(domain, MAX_DOMAIN_LENGTH) }),
        ...(name !== undefined && { name: sanitizeField(name, MAX_NAME_LENGTH) }),
        ...(description !== undefined && { description: sanitizeField(description, MAX_DESCRIPTION_LENGTH) || null }),
        ...(themeId !== undefined && { themeId: themeId || null }),
        ...(enabled !== undefined && { enabled }),
        ...(siteTitle !== undefined && { siteTitle: sanitizeField(siteTitle, MAX_SITE_TITLE_LENGTH) || null }),
        ...(siteDescription !== undefined && { siteDescription: sanitizeField(siteDescription, MAX_SITE_DESC_LENGTH) || null }),
        ...(siteKeywords !== undefined && { siteKeywords: sanitizeField(siteKeywords, MAX_KEYWORDS_LENGTH) || null }),
        ...(geoConfig !== undefined && {
          geoConfig: geoConfig ? safeJsonStringify(geoConfig, '地理配置') : null,
        }),
        ...(parsedNovelOffset !== undefined && { novelOffset: parsedNovelOffset }),
        ...(parsedChapterOffset !== undefined && { chapterOffset: parsedChapterOffset }),
        ...(customConfig !== undefined && {
          customConfig: customConfig ? safeJsonStringify(customConfig, '自定义配置') : null,
        }),
      },
      include: {
        theme: true,
      },
    });

    invalidateCache("sites:list:*");

    return NextResponse.json(site);
  } catch (error: unknown) {
    console.error("Update site error:", error);
    if (isPrismaError(error, "P2002")) {
      return apiError("站点域名已存在", 409);
    }
    return apiError("更新站点失败");
  }
});

// DELETE /api/sites/[id] - Delete a site
export const DELETE = withAuth(async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await db.$transaction(async (tx) => {
      const site = await tx.site.findUnique({ where: { id } });
      if (!site) {
        throw new Error('NOT_FOUND');
      }
      await tx.site.delete({ where: { id } });
    });
    invalidateCache("sites:list:*");
    return apiDeleted();
  } catch (error: unknown) {
    console.error("Delete site error:", error);
    if (error instanceof Error && error.message === 'NOT_FOUND') {
      return apiError("站点不存在", 404);
    }
    if (isPrismaError(error, "P2025")) {
      return apiError("站点不存在", 404);
    }
    return apiError("删除站点失败");
  }
});