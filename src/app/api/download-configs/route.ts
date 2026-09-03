import { db } from "@/lib/db";
import { safeJson, sanitizeField, asStringOrNull, apiError, apiSuccess } from "@/lib/api-utils";
import { NextRequest, NextResponse } from "next/server";
import { getOrCompute, invalidateCache } from "@/lib/cache";
import { withAuth } from "@/lib/api-auth";
import { MAX_NAME_LENGTH, VALID_FORMATS, VALID_AD_POSITIONS, MAX_CONTENT_LENGTH, MIN_AD_INTERVAL, MAX_AD_INTERVAL, MAX_PATTERN_LENGTH } from "@/lib/validation/download-configs";

// GET /api/download-configs - List all download configs
export const GET = withAuth(async function GET() {
  try {
    const configs = await getOrCompute("download-configs:list", 60_000, () =>
      db.downloadConfig.findMany({
        orderBy: { createdAt: "desc" },
        take: 100,
      })
    );
    return NextResponse.json(configs);
  } catch (error) {
    console.error("List download configs error:", error);
    return apiError("获取下载配置列表失败", 500);
  }
});

// POST /api/download-configs - Create a download config
export const POST = withAuth(async function POST(request: NextRequest) {
  try {
    let body;
    try {
      body = await safeJson(request);
    } catch {
      return apiError("请求数据格式错误", 400);
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

    const nameStr = sanitizeField(name, MAX_NAME_LENGTH);
    if (!nameStr) {
      return apiError("配置名称不能为空", 400);
    }
    if (nameStr.length > MAX_NAME_LENGTH) {
      return apiError(`配置名称不能超过${MAX_NAME_LENGTH}个字符`, 400);
    }
    const formatStr = asStringOrNull(format);
    if (formatStr && !(VALID_FORMATS as readonly string[]).includes(formatStr)) {
      return apiError(`文件格式只能是: ${VALID_FORMATS.join(", ")}`, 400);
    }
    if (insertConfusion && confusionText && typeof confusionText === "string" && confusionText.trim().length > MAX_CONTENT_LENGTH) {
      return apiError(`混淆文本不能超过${MAX_CONTENT_LENGTH}个字符`, 400);
    }
    if (insertAd) {
      if (adContent && typeof adContent === "string" && adContent.trim().length > MAX_CONTENT_LENGTH) {
        return apiError(`广告内容不能超过${MAX_CONTENT_LENGTH}个字符`, 400);
      }
      const adPositionStr = asStringOrNull(adPosition);
      if (adPositionStr && !VALID_AD_POSITIONS.includes(adPositionStr as (typeof VALID_AD_POSITIONS)[number])) {
        return apiError(`广告位置只能是: ${VALID_AD_POSITIONS.join(", ")}`, 400);
      }
    }
    const parsedInterval = adInterval !== undefined ? Math.min(Math.max(MIN_AD_INTERVAL, Math.floor(Number(adInterval) || 50)), MAX_AD_INTERVAL) : 50;
    if (insertSiteInfo && siteInfoContent && typeof siteInfoContent === "string" && siteInfoContent.trim().length > MAX_CONTENT_LENGTH) {
      return apiError(`站点信息内容不能超过${MAX_CONTENT_LENGTH}个字符`, 400);
    }
    const fileNamePatternStr = asStringOrNull(fileNamePattern);
    if (fileNamePatternStr && (fileNamePatternStr.includes('..') || fileNamePatternStr.includes('/') || fileNamePatternStr.includes('\\'))) {
      return apiError("文件名模式不能包含路径分隔符或..", 400);
    }
    if (fileNamePatternStr && fileNamePatternStr.trim().length > MAX_PATTERN_LENGTH) {
      return apiError(`文件名模式不能超过${MAX_PATTERN_LENGTH}个字符`, 400);
    }

    if (insertConfusion !== undefined && typeof insertConfusion !== 'boolean') {
      return apiError("insertConfusion 必须是布尔值", 400);
    }
    if (insertAd !== undefined && typeof insertAd !== 'boolean') {
      return apiError("insertAd 必须是布尔值", 400);
    }
    if (insertSiteInfo !== undefined && typeof insertSiteInfo !== 'boolean') {
      return apiError("insertSiteInfo 必须是布尔值", 400);
    }

    const config = await db.downloadConfig.create({
      data: {
        name: nameStr,
        format: formatStr || "txt",
        insertConfusion: insertConfusion || false,
        confusionText: insertConfusion ? sanitizeField(confusionText, MAX_CONTENT_LENGTH) || null : null,
        insertAd: insertAd || false,
        adContent: insertAd ? sanitizeField(adContent, MAX_CONTENT_LENGTH) || null : null,
        adInterval: parsedInterval,
        adPosition: asStringOrNull(adPosition) || "end",
        insertSiteInfo: insertSiteInfo || false,
        siteInfoContent: insertSiteInfo ? sanitizeField(siteInfoContent, MAX_CONTENT_LENGTH) || null : null,
        fileNamePattern: sanitizeField(fileNamePattern, MAX_PATTERN_LENGTH) || "{title} - {author}",
      },
    });

    invalidateCache("download-configs:list");

    return apiSuccess(config, 201);
  } catch (error) {
    console.error("Create download config error:", error);
    return apiError("创建下载配置失败", 500);
  }
});