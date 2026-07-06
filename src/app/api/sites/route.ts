import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

const MAX_NAME_LENGTH = 200;
const MAX_DOMAIN_LENGTH = 500;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_SITE_TITLE_LENGTH = 200;
const MAX_SITE_DESC_LENGTH = 500;
const MAX_KEYWORDS_LENGTH = 500;
const MAX_OFFSET = 10000;

// GET /api/sites - List all sites
export async function GET() {
  try {
    const sites = await db.site.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        theme: true,
      },
    });
    return NextResponse.json(sites);
  } catch (error) {
    console.error("List sites error:", error);
    return NextResponse.json({ error: "获取站点列表失败" }, { status: 500 });
  }
}

// POST /api/sites - Create a site
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
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

    if (!domain?.trim()) {
      return NextResponse.json({ error: "站点域名不能为空" }, { status: 400 });
    }
    if (domain.trim().length > MAX_DOMAIN_LENGTH) {
      return NextResponse.json({ error: `站点域名不能超过${MAX_DOMAIN_LENGTH}个字符` }, { status: 400 });
    }
    if (!name?.trim()) {
      return NextResponse.json({ error: "站点名称不能为空" }, { status: 400 });
    }
    if (name.trim().length > MAX_NAME_LENGTH) {
      return NextResponse.json({ error: `站点名称不能超过${MAX_NAME_LENGTH}个字符` }, { status: 400 });
    }
    if (description && typeof description === "string" && description.trim().length > MAX_DESCRIPTION_LENGTH) {
      return NextResponse.json({ error: `站点描述不能超过${MAX_DESCRIPTION_LENGTH}个字符` }, { status: 400 });
    }
    if (siteTitle && typeof siteTitle === "string" && siteTitle.trim().length > MAX_SITE_TITLE_LENGTH) {
      return NextResponse.json({ error: `站点标题不能超过${MAX_SITE_TITLE_LENGTH}个字符` }, { status: 400 });
    }
    if (siteDescription && typeof siteDescription === "string" && siteDescription.trim().length > MAX_SITE_DESC_LENGTH) {
      return NextResponse.json({ error: `站点描述不能超过${MAX_SITE_DESC_LENGTH}个字符` }, { status: 400 });
    }
    if (siteKeywords && typeof siteKeywords === "string" && siteKeywords.trim().length > MAX_KEYWORDS_LENGTH) {
      return NextResponse.json({ error: `站点关键词不能超过${MAX_KEYWORDS_LENGTH}个字符` }, { status: 400 });
    }
    if (themeId) {
      const themeExists = await db.theme.findUnique({ where: { id: themeId }, select: { id: true } });
      if (!themeExists) {
        return NextResponse.json({ error: "指定的主题不存在" }, { status: 400 });
      }
    }
    const parsedNovelOffset = novelOffset !== undefined ? Math.min(Math.max(0, Math.floor(Number(novelOffset) || 0)), MAX_OFFSET) : 0;
    const parsedChapterOffset = chapterOffset !== undefined ? Math.min(Math.max(0, Math.floor(Number(chapterOffset) || 0)), MAX_OFFSET) : 0;

    const site = await db.site.create({
      data: {
        domain: domain.trim(),
        name: name.trim(),
        description: description?.trim() || null,
        themeId: themeId || null,
        enabled: enabled !== undefined ? enabled : true,
        siteTitle: siteTitle?.trim() || null,
        siteDescription: siteDescription?.trim() || null,
        siteKeywords: siteKeywords?.trim() || null,
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
}