import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

// GET /api/download-configs/[id] - Get a single download config
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const config = await db.downloadConfig.findUnique({ where: { id } });

    if (!config) {
      return NextResponse.json({ error: "下载配置不存在" }, { status: 404 });
    }

    return NextResponse.json(config);
  } catch (error) {
    console.error("Get download config error:", error);
    return NextResponse.json({ error: "获取下载配置失败" }, { status: 500 });
  }
}

// PUT /api/download-configs/[id] - Update a download config
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const {
      name,
      enabled,
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

    if (name !== undefined && !name?.trim()) {
      return NextResponse.json({ error: "配置名称不能为空" }, { status: 400 });
    }

    const config = await db.downloadConfig.update({
      where: { id },
      data: {
        ...(name !== undefined && { name: name.trim() }),
        ...(enabled !== undefined && { enabled }),
        ...(format !== undefined && { format }),
        ...(insertConfusion !== undefined && { insertConfusion }),
        ...(confusionText !== undefined && {
          confusionText: insertConfusion ? confusionText?.trim() || null : null,
        }),
        ...(insertAd !== undefined && { insertAd }),
        ...(adContent !== undefined && {
          adContent: insertAd ? adContent?.trim() || null : null,
        }),
        ...(adInterval !== undefined && { adInterval }),
        ...(adPosition !== undefined && { adPosition }),
        ...(insertSiteInfo !== undefined && { insertSiteInfo }),
        ...(siteInfoContent !== undefined && {
          siteInfoContent: insertSiteInfo
            ? siteInfoContent?.trim() || null
            : null,
        }),
        ...(fileNamePattern !== undefined && {
          fileNamePattern: fileNamePattern?.trim() || "{title} - {author}",
        }),
      },
    });

    return NextResponse.json(config);
  } catch (error) {
    console.error("Update download config error:", error);
    return NextResponse.json({ error: "更新下载配置失败" }, { status: 500 });
  }
}

// DELETE /api/download-configs/[id] - Delete a download config
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await db.downloadConfig.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Delete download config error:", error);
    return NextResponse.json({ error: "删除下载配置失败" }, { status: 500 });
  }
}