import { db } from "@/lib/db";
import { safeJson, sanitizeField, isPrismaError } from "@/lib/api-utils";
import { NextRequest, NextResponse } from "next/server";
import { invalidateCache } from "@/lib/cache";
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

    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return NextResponse.json({ error: "enabled 必须是布尔值" }, { status: 400 });
    }
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
    if (fileNamePattern !== undefined && typeof fileNamePattern === "string") {
      if (fileNamePattern.includes('..') || fileNamePattern.includes('/') || fileNamePattern.includes('\\')) {
        return NextResponse.json({ error: "文件名模式不能包含路径分隔符或.." }, { status: 400 });
      }
      if (fileNamePattern.trim().length > MAX_PATTERN_LENGTH) {
        return NextResponse.json({ error: `文件名模式不能超过${MAX_PATTERN_LENGTH}个字符` }, { status: 400 });
      }
    }

    const parsedInterval = adInterval !== undefined ? Math.min(Math.max(MIN_AD_INTERVAL, Math.floor(Number(adInterval) || 50)), MAX_AD_INTERVAL) : undefined;

    // Single DB read for all conditional flag lookups (avoids up to 3 redundant queries)
    let existing: { insertConfusion: boolean; insertAd: boolean; insertSiteInfo: boolean } | null = null;
    async function getExisting() {
      if (!existing) {
        existing = await db.downloadConfig.findUnique({
          where: { id },
          select: { insertConfusion: true, insertAd: true, insertSiteInfo: true },
        });
      }
      return existing;
    }

    // If confusionText is being updated but insertConfusion is not provided,
    // read the existing config to get the current insertConfusion value
    let effectiveInsertConfusion = insertConfusion;
    if (confusionText !== undefined && insertConfusion === undefined) {
      const existingConfig = await getExisting();
      effectiveInsertConfusion = existingConfig?.insertConfusion ?? false;
    }

    // Similarly for adContent
    let effectiveInsertAd = insertAd;
    if (adContent !== undefined && insertAd === undefined) {
      const existingConfig = await getExisting();
      effectiveInsertAd = existingConfig?.insertAd ?? false;
    }

    // Similarly for siteInfoContent
    let effectiveInsertSiteInfo = insertSiteInfo;
    if (siteInfoContent !== undefined && insertSiteInfo === undefined) {
      const existingConfig = await getExisting();
      effectiveInsertSiteInfo = existingConfig?.insertSiteInfo ?? false;
    }

    const config = await db.downloadConfig.update({
      where: { id },
      data: {
        ...(name !== undefined && { name: sanitizeField(name, MAX_NAME_LENGTH) }),
        ...(enabled !== undefined && { enabled }),
        ...(format !== undefined && { format }),
        ...(insertConfusion !== undefined && { insertConfusion }),
        ...(confusionText !== undefined && {
          confusionText: effectiveInsertConfusion ? sanitizeField(confusionText, MAX_CONTENT_LENGTH) || null : null,
        }),
        ...(insertAd !== undefined && { insertAd }),
        ...(adContent !== undefined && {
          adContent: effectiveInsertAd ? sanitizeField(adContent, MAX_CONTENT_LENGTH) || null : null,
        }),
        ...(parsedInterval !== undefined && { adInterval: parsedInterval }),
        ...(adPosition !== undefined && { adPosition }),
        ...(insertSiteInfo !== undefined && { insertSiteInfo }),
        ...(siteInfoContent !== undefined && {
          siteInfoContent: effectiveInsertSiteInfo
            ? sanitizeField(siteInfoContent, MAX_CONTENT_LENGTH) || null
            : null,
        }),
        ...(fileNamePattern !== undefined && {
          fileNamePattern: sanitizeField(fileNamePattern, MAX_PATTERN_LENGTH) || "{title} - {author}",
        }),
      },
    });

    invalidateCache("download-configs:list");

    return NextResponse.json(config);
  } catch (error: unknown) {
    console.error("Update download config error:", error);
    if (isPrismaError(error, "P2025")) {
      return NextResponse.json({ error: "下载配置不存在" }, { status: 404 });
    }
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
    invalidateCache("download-configs:list");
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    console.error("Delete download config error:", error);
    if (isPrismaError(error, "P2025")) {
      return NextResponse.json({ error: "下载配置不存在" }, { status: 404 });
    }
    return NextResponse.json({ error: "删除下载配置失败" }, { status: 500 });
  }
});