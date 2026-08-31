import { db } from "@/lib/db";
import { sanitizeField, safeJson, isPrismaError, apiError, apiDeleted } from "@/lib/api-utils";
import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { isSafeUrl } from "@/lib/sanitize";
import {
  MAX_TITLE_LENGTH,
  MAX_URL_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  URL_RE,
  isValidLinkType,
} from "@/lib/validation/friendly-links";

// PUT /api/friendly-links/[id] - Update friendly link (requires auth)
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
      return apiError("请求数据格式错误", 400);
    }

    const { title, url, logo, description, linkType, siteId, novelId, sortOrder, enabled, nofollow } = body;

    // Validate fields if provided
    if (title !== undefined) {
      const sanitizedTitle = sanitizeField(title, MAX_TITLE_LENGTH);
      if (!sanitizedTitle) {
        return apiError("链接名称不能为空", 400);
      }
    }

    if (url !== undefined) {
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
    }

    if (logo !== undefined && logo !== null) {
      const sanitizedLogo = sanitizeField(logo, MAX_URL_LENGTH);
      if (sanitizedLogo && !isSafeUrl(sanitizedLogo)) {
        return apiError("Logo URL不安全", 400);
      }
    }

    if (linkType !== undefined) {
      const resolvedLinkType = sanitizeField(linkType, 20);
      if (!isValidLinkType(resolvedLinkType)) {
        return apiError("linkType 必须是 manual、site_home 或 site_novel", 400);
      }

      if ((resolvedLinkType === 'site_home' || resolvedLinkType === 'site_novel') && siteId) {
        const siteExists = await db.site.findUnique({ where: { id: siteId }, select: { id: true } });
        if (!siteExists) {
          return apiError("关联的站点不存在", 400);
        }
      }

      if (resolvedLinkType === 'site_novel' && novelId) {
        const novelExists = await db.novel.findUnique({ where: { id: novelId }, select: { id: true } });
        if (!novelExists) {
          return apiError("关联的书籍不存在", 400);
        }
      }
    }

    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return apiError("enabled 必须是布尔值", 400);
    }
    if (nofollow !== undefined && typeof nofollow !== 'boolean') {
      return apiError("nofollow 必须是布尔值", 400);
    }

    // Check existence
    const existing = await db.friendlyLink.findUnique({ where: { id } });
    if (!existing) {
      return apiError("友情链接不存在", 404);
    }

    const parsedSortOrder = sortOrder !== undefined ? Math.min(Math.max(-10000, Math.floor(Number(sortOrder) || 0)), 10000) : undefined;

    const link = await db.friendlyLink.update({
      where: { id },
      data: {
        ...(title !== undefined && { title: sanitizeField(title, MAX_TITLE_LENGTH) }),
        ...(url !== undefined && { url: sanitizeField(url, MAX_URL_LENGTH) }),
        ...(logo !== undefined && { logo: logo ? sanitizeField(logo, MAX_URL_LENGTH) || null : null }),
        ...(description !== undefined && { description: sanitizeField(description, MAX_DESCRIPTION_LENGTH) || null }),
        ...(linkType !== undefined && { linkType: sanitizeField(linkType, 20) }),
        ...(siteId !== undefined && { siteId: siteId || null }),
        ...(novelId !== undefined && { novelId: novelId || null }),
        ...(parsedSortOrder !== undefined && { sortOrder: parsedSortOrder }),
        ...(enabled !== undefined && { enabled }),
        ...(nofollow !== undefined && { nofollow }),
      },
    });

    return NextResponse.json(link);
  } catch (error: unknown) {
    console.error("Update friendly link error:", error);
    if (isPrismaError(error, "P2025")) {
      return apiError("友情链接不存在", 404);
    }
    return apiError("更新友情链接失败");
  }
});

// DELETE /api/friendly-links/[id] - Delete friendly link (requires auth)
export const DELETE = withAuth(async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const existing = await db.friendlyLink.findUnique({ where: { id } });
    if (!existing) {
      return apiError("友情链接不存在", 404);
    }
    await db.friendlyLink.delete({ where: { id } });
    return apiDeleted();
  } catch (error: unknown) {
    console.error("Delete friendly link error:", error);
    if (isPrismaError(error, "P2025")) {
      return apiError("友情链接不存在", 404);
    }
    return apiError("删除友情链接失败");
  }
});
