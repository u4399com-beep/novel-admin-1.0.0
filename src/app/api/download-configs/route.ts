import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

// GET /api/download-configs - List all download configs
export async function GET() {
  try {
    const configs = await db.downloadConfig.findMany({
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json(configs);
  } catch (error) {
    console.error("List download configs error:", error);
    return NextResponse.json({ error: "获取下载配置列表失败" }, { status: 500 });
  }
}

// POST /api/download-configs - Create a download config
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      name,
      format,
      insertConfusion,
      confusionText,
      insertAd,
      adContent,
      adInterval,
      adPosition,
      insertSiteInfo,
      siteInfoContent,
      fileNamePattern,
    } = body;

    if (!name?.trim()) {
      return NextResponse.json({ error: "配置名称不能为空" }, { status: 400 });
    }

    const config = await db.downloadConfig.create({
      data: {
        name: name.trim(),
        format: format || "txt",
        insertConfusion: insertConfusion || false,
        confusionText: insertConfusion ? confusionText?.trim() || null : null,
        insertAd: insertAd || false,
        adContent: insertAd ? adContent?.trim() || null : null,
        adInterval: adInterval || 50,
        adPosition: adPosition || "end",
        insertSiteInfo: insertSiteInfo || false,
        siteInfoContent: insertSiteInfo ? siteInfoContent?.trim() || null : null,
        fileNamePattern: fileNamePattern?.trim() || "{title} - {author}",
      },
    });

    return NextResponse.json(config, { status: 201 });
  } catch (error) {
    console.error("Create download config error:", error);
    return NextResponse.json({ error: "创建下载配置失败" }, { status: 500 });
  }
}