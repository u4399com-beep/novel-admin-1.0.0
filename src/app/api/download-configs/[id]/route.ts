import { db } from "@/lib/db";
import { safeJson } from "@/lib/api-utils";
import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";

const MAX_NAME_LENGTH = 200;
const VALID_FORMATS = ["txt", "epub"];
const VALID_AD_POSITIONS = ["start", "middle", "end"];
const MAX_CONTENT_LENGTH = 5000;
const MIN_AD_INTERVAL = 1;
const MAX_AD_INTERVAL = 1000;
const MAX_PATTERN_LENGTH = 500;

// GET /api/download-configs/[id] - Get a single download config
export const GET = withAuth(async function GET(
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
});

// PUT /api/download-configs/[id] - Update a download config
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
    if (name !== undefined && name.trim().length > MAX_NAME_LENGTH) {
      return NextResponse.json({ error: `配置名称不能超过${MAX_NAME_LENGTH}个字符` }, { status: 400 });
    }
    if (format !== undefined && !VALID_FORMATS.includes(format)) {
      return NextResponse.json({ error: `文件格式只能是: ${VALID_FORMATS.join(", ")}` }, { status: 400 });
    }
    if (confusionText !== undefined && typeof confusionText === "string" && confusionText.trim().length > MAX_CONTENT_LENGTH) {
      return NextResponse.json({ error: `混淆文本不能超过${MAX_CONTENT_LENGTH}个字符` }, { status: 400 });
    }
    if (adContent !== undefined && typeof adContent === "string" && adContent.trim().length > MAX_CONTENT_LENGTH) {
      return NextResponse.json({ error: `广告内容不能超过${MAX_CONTENT_LENGTH}个字符` }, { status: 400 });
    }
    if (adInterval !== undefined) {
      const parsed = Math.floor(Number(adInterval) || 50);
      if (parsed < MIN_AD_INTERVAL || parsed > MAX_AD_INTERVAL) {
        return NextResponse.json({ error: `广告间隔必须在${MIN_AD_INTERVAL}-${MAX_AD_INTERVAL}之间` }, { status: 400 });
      }
    }
    if (adPosition !== undefined && !VALID_AD_POSITIONS.includes(adPosition)) {
      return NextResponse.json({ error: `广告位置只能是: ${VALID_AD_POSITIONS.join(", ")}` }, { status: 400 });
    }
    if (siteInfoContent !== undefined && typeof siteInfoContent === "string" && siteInfoContent.trim().length > MAX_CONTENT_LENGTH) {
      return NextResponse.json({ error: `站点信息内容不能超过${MAX_CONTENT_LENGTH}个字符` }, { status: 400 });
    }
    if (fileNamePattern !== undefined && typeof fileNamePattern === "string" && fileNamePattern.trim().length > MAX_PATTERN_LENGTH) {
      return NextResponse.json({ error: `文件名模式不能超过${MAX_PATTERN_LENGTH}个字符` }, { status: 400 });
    }

    const parsedInterval = adInterval !== undefined ? Math.min(Math.max(MIN_AD_INTERVAL, Math.floor(Number(adInterval) || 50)), MAX_AD_INTERVAL) : undefined;

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
        ...(parsedInterval !== undefined && { adInterval: parsedInterval }),
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
});

// DELETE /api/download-configs/[id] - Delete a download config
export const DELETE = withAuth(async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const existing = await db.downloadConfig.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "下载配置不存在" }, { status: 404 });
    }
    await db.downloadConfig.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    console.error("Delete download config error:", error);
    if (error && typeof error === "object" && "code" in error && (error as { code: string }).code === "P2025") {
      return NextResponse.json({ error: "下载配置不存在" }, { status: 404 });
    }
    return NextResponse.json({ error: "删除下载配置失败" }, { status: 500 });
  }
});