import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

const MAX_NAME_LENGTH = 200;
const MAX_DOMAIN_LENGTH = 500;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_SITE_TITLE_LENGTH = 200;
const MAX_SITE_DESC_LENGTH = 500;
const MAX_KEYWORDS_LENGTH = 500;
const MAX_OFFSET = 10000;

// GET /api/sites/[id] - Get a single site
export async function GET(
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
}

// PUT /api/sites/[id] - Update a site
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
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

    if (domain !== undefined) {
      if (!domain?.trim()) {
        return NextResponse.json({ error: "站点域名不能为空" }, { status: 400 });
      }
      if (domain.trim().length > MAX_DOMAIN_LENGTH) {
        return NextResponse.json({ error: `站点域名不能超过${MAX_DOMAIN_LENGTH}个字符` }, { status: 400 });
      }
    }
    if (name !== undefined) {
      if (!name?.trim()) {
        return NextResponse.json({ error: "站点名称不能为空" }, { status: 400 });
      }
      if (name.trim().length > MAX_NAME_LENGTH) {
        return NextResponse.json({ error: `站点名称不能超过${MAX_NAME_LENGTH}个字符` }, { status: 400 });
      }
    }
    if (description !== undefined && typeof description === "string" && description.trim().length > MAX_DESCRIPTION_LENGTH) {
      return NextResponse.json({ error: `站点描述不能超过${MAX_DESCRIPTION_LENGTH}个字符` }, { status: 400 });
    }
    if (siteTitle !== undefined && typeof siteTitle === "string" && siteTitle.trim().length > MAX_SITE_TITLE_LENGTH) {
      return NextResponse.json({ error: `站点标题不能超过${MAX_SITE_TITLE_LENGTH}个字符` }, { status: 400 });
    }
    if (siteDescription !== undefined && typeof siteDescription === "string" && siteDescription.trim().length > MAX_SITE_DESC_LENGTH) {
      return NextResponse.json({ error: `站点描述不能超过${MAX_SITE_DESC_LENGTH}个字符` }, { status: 400 });
    }
    if (siteKeywords !== undefined && typeof siteKeywords === "string" && siteKeywords.trim().length > MAX_KEYWORDS_LENGTH) {
      return NextResponse.json({ error: `站点关键词不能超过${MAX_KEYWORDS_LENGTH}个字符` }, { status: 400 });
    }
    if (themeId !== undefined && themeId) {
      const themeExists = await db.theme.findUnique({ where: { id: themeId }, select: { id: true } });
      if (!themeExists) {
        return NextResponse.json({ error: "指定的主题不存在" }, { status: 400 });
      }
    }
    const parsedNovelOffset = novelOffset !== undefined ? Math.min(Math.max(0, Math.floor(Number(novelOffset) || 0)), MAX_OFFSET) : undefined;
    const parsedChapterOffset = chapterOffset !== undefined ? Math.min(Math.max(0, Math.floor(Number(chapterOffset) || 0)), MAX_OFFSET) : undefined;

    const site = await db.site.update({
      where: { id },
      data: {
        ...(domain !== undefined && { domain: domain.trim() }),
        ...(name !== undefined && { name: name.trim() }),
        ...(description !== undefined && { description: description?.trim() || null }),
        ...(themeId !== undefined && { themeId: themeId || null }),
        ...(enabled !== undefined && { enabled }),
        ...(siteTitle !== undefined && { siteTitle: siteTitle?.trim() || null }),
        ...(siteDescription !== undefined && { siteDescription: siteDescription?.trim() || null }),
        ...(siteKeywords !== undefined && { siteKeywords: siteKeywords?.trim() || null }),
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

    return NextResponse.json(site);
  } catch (error: unknown) {
    console.error("Update site error:", error);
    const msg = error instanceof Error && error.message.includes("Unique")
      ? "站点域名已存在"
      : "更新站点失败";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// DELETE /api/sites/[id] - Delete a site
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await db.site.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Delete site error:", error);
    return NextResponse.json({ error: "删除站点失败" }, { status: 500 });
  }
}