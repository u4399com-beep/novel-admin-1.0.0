import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

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
    if (!name?.trim()) {
      return NextResponse.json({ error: "站点名称不能为空" }, { status: 400 });
    }

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
        novelOffset: novelOffset || 0,
        chapterOffset: chapterOffset || 0,
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