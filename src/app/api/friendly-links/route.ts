import { db } from "@/lib/db";
import { sanitizeField, safeJson, isPrismaError, apiError, apiSuccess, parsePagination } from "@/lib/api-utils";
import { NextRequest, NextResponse } from "next/server";
import { withAuth, withPublicRateLimit } from "@/lib/api-auth";
import { isSafeUrl } from "@/lib/sanitize";
import {
  MAX_TITLE_LENGTH,
  MAX_URL_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  URL_RE,
  isValidLinkType,
} from "@/lib/validation/friendly-links";

// GET /api/friendly-links - List enabled friendly links (public, rate limited)
export const GET = withPublicRateLimit({ capacity: 60, refillRate: 2 }, async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const linkType = searchParams.get('linkType');

    const where: Record<string, unknown> = { enabled: true };
    if (linkType && isValidLinkType(linkType)) {
      where.linkType = linkType;
    }

    const links = await db.friendlyLink.findMany({
      where,
      orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
      include: {
        ...(linkType === 'site_home' || linkType === 'site_novel' || !linkType
          ? { site: { select: { id: true, domain: true, name: true, enabled: true } } }
          : {}),
        ...(linkType === 'site_novel' || !linkType
          ? { novel: { select: { id: true, title: true, slugs: { where: { isActive: true }, take: 1, select: { slug: true } } } } }
          : {}),
      },
    });

    return NextResponse.json(links);
  } catch (error) {
    console.error("List friendly links error:", error);
    return apiError("获取友情链接列表失败");
  }
});

// POST /api/friendly-links - Create friendly link (requires auth)
export const POST = withAuth(async function POST(request: NextRequest) {
  try {
    let body;
    try {
      body = await safeJson(request);
    } catch {
      return apiError("请求数据格式错误", 400);
    }

    const { title, url, logo, description, linkType, siteId, novelId, sortOrder, enabled, nofollow } = body;

    const sanitizedTitle = sanitizeField(title, MAX_TITLE_LENGTH);
    if (!sanitizedTitle) {
      return apiError("链接名称不能为空", 400);
    }

    const sanitizedUrl = sanitizeField(url, MAX_URL_LENGTH);
    if (!sanitizedUrl) {
      return apiError("链接URL不能为空", 400);
    }
    if (!URL_RE.test(sanitizedUrl)) {
      return apiError("链接URL格式不合法，必须以 http:// 或 https:// 开头", 400);
    }
    if (!isSafeUrl(sanitizedUrl)) {
      return apiError("链接URL不安全", 400);
    }

    if (logo !== undefined && logo !== null) {
      const sanitizedLogo = sanitizeField(logo, MAX_URL_LENGTH);
      if (sanitizedLogo && !isSafeUrl(sanitizedLogo)) {
        return apiError("Logo URL不安全", 400);
      }
    }

    const resolvedLinkType = linkType ? sanitizeField(linkType, 20) : 'manual';
    if (!isValidLinkType(resolvedLinkType)) {
      return apiError("linkType 必须是 manual、site_home 或 site_novel", 400);
    }

    // site_home and site_novel require siteId
    if ((resolvedLinkType === 'site_home' || resolvedLinkType === 'site_novel') && siteId) {
      const siteExists = await db.site.findUnique({ where: { id: siteId }, select: { id: true } });
      if (!siteExists) {
        return apiError("关联的站点不存在", 400);
      }
    }

    // site_novel requires novelId
    if (resolvedLinkType === 'site_novel' && novelId) {
      const novelExists = await db.novel.findUnique({ where: { id: novelId }, select: { id: true } });
      if (!novelExists) {
        return apiError("关联的书籍不存在", 400);
      }
    }

    const parsedSortOrder = sortOrder !== undefined ? Math.min(Math.max(-10000, Math.floor(Number(sortOrder) || 0)), 10000) : 0;

    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return apiError("enabled 必须是布尔值", 400);
    }
    if (nofollow !== undefined && typeof nofollow !== 'boolean') {
      return apiError("nofollow 必须是布尔值", 400);
    }

    const link = await db.friendlyLink.create({
      data: {
        title: sanitizedTitle,
        url: sanitizedUrl,
        logo: logo ? sanitizeField(logo, MAX_URL_LENGTH) || null : null,
        description: sanitizeField(description, MAX_DESCRIPTION_LENGTH) || null,
        linkType: resolvedLinkType,
        siteId: siteId || null,
        novelId: novelId || null,
        sortOrder: parsedSortOrder,
        enabled: enabled !== undefined ? enabled : true,
        nofollow: nofollow !== undefined ? nofollow : false,
      },
    });

    return apiSuccess(link, 201);
  } catch (error: unknown) {
    console.error("Create friendly link error:", error);
    if (isPrismaError(error, "P2002")) {
      return apiError("友情链接创建失败（唯一约束冲突）", 409);
    }
    return apiError("创建友情链接失败");
  }
});
