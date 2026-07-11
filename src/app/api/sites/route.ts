import { db } from "@/lib/db";
import { parsePagination, sanitizeField, safeJson } from "@/lib/api-utils";
import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";

const MAX_NAME_LENGTH = 200;
const MAX_DOMAIN_LENGTH = 500;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_SITE_TITLE_LENGTH = 200;
const MAX_SITE_DESC_LENGTH = 500;
const MAX_KEYWORDS_LENGTH = 500;
const MAX_OFFSET = 10000;
const MAX_JSON_CONFIG_SIZE = 51200; // 50KB

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

// GET /api/sites - List all sites with pagination
export const GET = withAuth(async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const { page, pageSize, skip } = parsePagination(searchParams);

    const [sites, total] = await Promise.all([
      db.site.findMany({
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
        include: {
          theme: true,
        },
      }),
      db.site.count(),
    ]);

    return NextResponse.json({
      sites,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (error) {
    console.error("List sites error:", error);
    return NextResponse.json({ error: "获取站点列表失败" }, { status: 500 });
  }
});

// POST /api/sites - Create a site
export const POST = withAuth(async function POST(request: NextRequest) {
  try {
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

    const sanitizedDomain = sanitizeField(domain, MAX_DOMAIN_LENGTH);
    if (!sanitizedDomain) {
      return NextResponse.json({ error: "站点域名不能为空" }, { status: 400 });
    }
    const sanitizedName = sanitizeField(name, MAX_NAME_LENGTH);
    if (!sanitizedName) {
      return NextResponse.json({ error: "站点名称不能为空" }, { status: 400 });
    }
    if (themeId) {
      const themeExists = await db.theme.findUnique({ where: { id: themeId }, select: { id: true } });
      if (!themeExists) {
        return NextResponse.json({ error: "指定的主题不存在" }, { status: 400 });
      }
    }
    const geoConfigError = validateJsonObject(geoConfig, '地理配置');
    if (geoConfigError) {
      return NextResponse.json({ error: geoConfigError }, { status: 400 });
    }
    const customConfigError = validateJsonObject(customConfig, '自定义配置');
    if (customConfigError) {
      return NextResponse.json({ error: customConfigError }, { status: 400 });
    }

    const parsedNovelOffset = novelOffset !== undefined ? Math.min(Math.max(0, Math.floor(Number(novelOffset) || 0)), MAX_OFFSET) : 0;
    const parsedChapterOffset = chapterOffset !== undefined ? Math.min(Math.max(0, Math.floor(Number(chapterOffset) || 0)), MAX_OFFSET) : 0;

    const site = await db.site.create({
      data: {
        domain: sanitizedDomain,
        name: sanitizedName,
        description: sanitizeField(description, MAX_DESCRIPTION_LENGTH) || null,
        themeId: themeId || null,
        enabled: enabled !== undefined ? enabled : true,
        siteTitle: sanitizeField(siteTitle, MAX_SITE_TITLE_LENGTH) || null,
        siteDescription: sanitizeField(siteDescription, MAX_SITE_DESC_LENGTH) || null,
        siteKeywords: sanitizeField(siteKeywords, MAX_KEYWORDS_LENGTH) || null,
        geoConfig: geoConfig ? JSON.stringify(geoConfig) : null,
        novelOffset: parsedNovelOffset,
        chapterOffset: parsedChapterOffset,
        customConfig: customConfig ? JSON.stringify(customConfig) : null,
      },
      include: {
        theme: true,
      },
    });

    return NextResponse.json(site, { status: 201 });
  } catch (error: unknown) {
    console.error("Create site error:", error);
    const msg = error instanceof Error && error.message.includes("Unique")
      ? "站点域名已存在"
      : "创建站点失败";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
});