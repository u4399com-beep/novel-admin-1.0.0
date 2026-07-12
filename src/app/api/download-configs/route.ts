import { db } from "@/lib/db";
import { safeJson, sanitizeField } from "@/lib/api-utils";
import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";

const MAX_NAME_LENGTH = 200;
const VALID_FORMATS = ["txt", "epub"];
const VALID_AD_POSITIONS = ["start", "middle", "end"];
const MAX_CONTENT_LENGTH = 5000;
const MIN_AD_INTERVAL = 1;
const MAX_AD_INTERVAL = 1000;
const MAX_PATTERN_LENGTH = 500;

// GET /api/download-configs - List all download configs
export const GET = withAuth(async function GET() {
  try {
    const configs = await db.downloadConfig.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return NextResponse.json(configs);
  } catch (error) {
    console.error("List download configs error:", error);
    return NextResponse.json({ error: "获取下载配置列表失败" }, { status: 500 });
  }
});

// POST /api/download-configs - Create a download config
export const POST = withAuth(async function POST(request: NextRequest) {
  try {
    let body;
    try {
      body = await safeJson(request);
    } catch {
      return NextResponse.json({ error: "请求数据格式错误" }, { status: 400 });
    }
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
    if (name.trim().length > MAX_NAME_LENGTH) {
      return NextResponse.json({ error: `配置名称不能超过${MAX_NAME_LENGTH}个字符` }, { status: 400 });
    }
    if (format && !VALID_FORMATS.includes(format)) {
      return NextResponse.json({ error: `文件格式只能是: ${VALID_FORMATS.join(", ")}` }, { status: 400 });
    }
    if (insertConfusion && confusionText && typeof confusionText === "string" && confusionText.trim().length > MAX_CONTENT_LENGTH) {
      return NextResponse.json({ error: `混淆文本不能超过${MAX_CONTENT_LENGTH}个字符` }, { status: 400 });
    }
    if (insertAd) {
      if (adContent && typeof adContent === "string" && adContent.trim().length > MAX_CONTENT_LENGTH) {
        return NextResponse.json({ error: `广告内容不能超过${MAX_CONTENT_LENGTH}个字符` }, { status: 400 });
      }
      if (adPosition && !VALID_AD_POSITIONS.includes(adPosition)) {
        return NextResponse.json({ error: `广告位置只能是: ${VALID_AD_POSITIONS.join(", ")}` }, { status: 400 });
      }
    }
    const parsedInterval = adInterval !== undefined ? Math.min(Math.max(MIN_AD_INTERVAL, Math.floor(Number(adInterval) || 50)), MAX_AD_INTERVAL) : 50;
    if (insertSiteInfo && siteInfoContent && typeof siteInfoContent === "string" && siteInfoContent.trim().length > MAX_CONTENT_LENGTH) {
      return NextResponse.json({ error: `站点信息内容不能超过${MAX_CONTENT_LENGTH}个字符` }, { status: 400 });
    }
    if (fileNamePattern && typeof fileNamePattern === "string" && fileNamePattern.trim().length > MAX_PATTERN_LENGTH) {
      return NextResponse.json({ error: `文件名模式不能超过${MAX_PATTERN_LENGTH}个字符` }, { status: 400 });
    }

    const config = await db.downloadConfig.create({
      data: {
        name: sanitizeField(name, MAX_NAME_LENGTH),
        format: format || "txt",
        insertConfusion: insertConfusion || false,
        confusionText: insertConfusion ? sanitizeField(confusionText, MAX_CONTENT_LENGTH) || null : null,
        insertAd: insertAd || false,
        adContent: insertAd ? sanitizeField(adContent, MAX_CONTENT_LENGTH) || null : null,
        adInterval: parsedInterval,
        adPosition: adPosition || "end",
        insertSiteInfo: insertSiteInfo || false,
        siteInfoContent: insertSiteInfo ? sanitizeField(siteInfoContent, MAX_CONTENT_LENGTH) || null : null,
        fileNamePattern: sanitizeField(fileNamePattern, MAX_PATTERN_LENGTH) || "{title} - {author}",
      },
    });

    return NextResponse.json(config, { status: 201 });
  } catch (error) {
    console.error("Create download config error:", error);
    return NextResponse.json({ error: "创建下载配置失败" }, { status: 500 });
  }
});