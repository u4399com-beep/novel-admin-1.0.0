import { db } from "@/lib/db";
import { parsePagination, sanitizeField, safeJson, isPrismaError } from "@/lib/api-utils";
import { NextRequest, NextResponse } from "next/server";
import { invalidateCache } from "@/lib/cache";
import { withAuth } from "@/lib/api-auth";

const MAX_NAME_LENGTH = 200;
const MAX_DOMAIN_LENGTH = 500;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_SITE_TITLE_LENGTH = 200;
const MAX_SITE_DESC_LENGTH = 500;
const MAX_KEYWORDS_LENGTH = 500;
const MAX_OFFSET = 10000;
const MAX_JSON_CONFIG_SIZE = 51200; // 50KB
const DOMAIN_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;

function validateJsonObject(value: unknown, fieldName: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    return `${fieldName}必须是JSON对象`;
  }
  const str = JSON.stringify(value);
  if (str.length > MAX_JSON_CONFIG_SIZE) {
    return `${fieldName}大小不能超过${Math.floor(MAX_JSON_CONFIG_SIZE / 1024)}KB`;
  }
  return null;
}

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
      return NextResponse.json({ error: "站点不存在" }, { status: 404 });
    }

    return NextResponse.json(site);
  } catch (error) {
    console.error("Get site error:", error);
    return NextResponse.json({ error: "获取站点详情失败" }, { status: 500 });
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
      return NextResponse.json({ error: "请求数据格式错误" }, { status: 400 });
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
        return NextResponse.json({ error: "站点域名不能为空" }, { status: 400 });
      }
      if (!DOMAIN_RE.test(sanitizedDomain)) {
        return NextResponse.json({ error: "站点域名格式不合法" }, { status: 400 });
      }
    }
    if (name !== undefined) {
      const sanitizedName = sanitizeField(name, MAX_NAME_LENGTH);
      if (!sanitizedName) {
        return NextResponse.json({ error: "站点名称不能为空" }, { status: 400 });
      }
    }
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return NextResponse.json({ error: "enabled 必须是布尔值" }, { status: 400 });
    }
    if (themeId !== undefined && themeId) {
      const themeExists = await db.theme.findUnique({ where: { id: themeId }, select: { id: true } });
      if (!themeExists) {
        return NextResponse.json({ error: "指定的主题不存在" }, { status: 400 });
      }
    }
    const parsedNovelOffset = novelOffset !== undefined ? Math.min(Math.max(0, Math.floor(Number(novelOffset) || 0)), MAX_OFFSET) : undefined;
    const parsedChapterOffset = chapterOffset !== undefined ? Math.min(Math.max(0, Math.floor(Number(chapterOffset) || 0)), MAX_OFFSET) : undefined;

    if (geoConfig !== undefined) {
      const geoConfigError = validateJsonObject(geoConfig, '地理配置');
      if (geoConfigError) {
        return NextResponse.json({ error: geoConfigError }, { status: 400 });
      }
    }
    if (customConfig !== undefined) {
      const customConfigError = validateJsonObject(customConfig, '自定义配置');
      if (customConfigError) {
        return NextResponse.json({ error: customConfigError }, { status: 400 });
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
          geoConfig: geoConfig ? JSON.stringify(geoConfig) : null,
        }),
        ...(parsedNovelOffset !== undefined && { novelOffset: parsedNovelOffset }),
        ...(parsedChapterOffset !== undefined && { chapterOffset: parsedChapterOffset }),
        ...(customConfig !== undefined && {
          customConfig: customConfig ? JSON.stringify(customConfig) : null,
        }),
      },
      include: {
        theme: true,
      },
    });

    invalidateCache("sites:list");

    return NextResponse.json(site);
  } catch (error: unknown) {
    console.error("Update site error:", error);
    if (isPrismaError(error, "P2002")) {
      return NextResponse.json({ error: "站点域名已存在" }, { status: 409 });
    }
    return NextResponse.json({ error: "更新站点失败" }, { status: 500 });
  }
});

// DELETE /api/sites/[id] - Delete a site
export const DELETE = withAuth(async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const existing = await db.site.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "站点不存在" }, { status: 404 });
    }
    await db.site.delete({ where: { id } });
    invalidateCache("sites:list");
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    console.error("Delete site error:", error);
    if (isPrismaError(error, "P2025")) {
      return NextResponse.json({ error: "站点不存在" }, { status: 404 });
    }
    return NextResponse.json({ error: "删除站点失败" }, { status: 500 });
  }
});