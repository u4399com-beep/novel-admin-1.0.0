import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

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

    if (domain !== undefined && !domain?.trim()) {
      return NextResponse.json({ error: "站点域名不能为空" }, { status: 400 });
    }

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
        ...(novelOffset !== undefined && { novelOffset: novelOffset || 0 }),
        ...(chapterOffset !== undefined && { chapterOffset: chapterOffset || 0 }),
        ...(customConfig !== undefined && {
          customConfig: customConfig ? JSON.stringify(customConfig) : null,
        }),
      },
      include: {
        theme: true,
      },
    });

    return NextResponse.json(site);
  } catch (error) {
    console.error("Update site error:", error);
    return NextResponse.json({ error: "更新站点失败" }, { status: 500 });
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