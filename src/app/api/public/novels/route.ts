import { Prisma } from '@prisma/client';
import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";
import { sanitizeField, apiError, parsePagination } from "@/lib/api-utils";
import { withPublicRateLimit } from "@/lib/api-auth";

// ─── 23qb.net 字数区间映射 ─────────────────────────────────────────
const WORD_COUNT_RANGES: Record<string, { min: number; max: number }> = {
  all:        { min: 0,     max: Infinity },
  under_30w:  { min: 0,     max: 300000 },
  "30w_50w":  { min: 300000, max: 500000 },
  "50w_100w":  { min: 500000, max: 1000000 },
  "100w_200w": { min: 1000000, max: 2000000 },
  "200w_400w": { min: 2000000, max: 4000000 },
  over_400w:  { min: 4000000, max: Infinity },
};

// ─── 23qb.net 排序映射 ─────────────────────────────────────────────
const SORT_MAP: Record<string, { field: string; direction: "asc" | "desc" }> = {
  last_update:     { field: "updatedAt",     direction: "desc" },
  new_entry:       { field: "createdAt",     direction: "desc" },
  new_hot:         { field: "createdAt",     direction: "desc" },
  weekly_clicks:   { field: "clickCount",    direction: "desc" },
  monthly_clicks:  { field: "clickCount",    direction: "desc" },
  weekly_rec:      { field: "favoriteCount", direction: "desc" },
  monthly_rec:     { field: "favoriteCount", direction: "desc" },
  favorites:       { field: "favoriteCount", direction: "desc" },
  total_favorites: { field: "favoriteCount", direction: "desc" },
};

/**
 * Public novel listing API — no auth required.
 * Cloned from 23qb.net filter system:
 *   - categorySlug: 分类筛选
 *   - wordCount: 字数筛选 (all|under_30w|30w_50w|50w_100w|100w_200w|200w_400w|over_400w)
 *   - status: 状态筛选 (ongoing|completed|"")
 *   - sort: 排序方式 (last_update|new_entry|new_hot|weekly_click|...)
 */
export const GET = withPublicRateLimit({ capacity: 60, refillRate: 1 }, async (request: NextRequest) => {
  try {
    const { searchParams } = new URL(request.url);
    const { page, pageSize, skip } = parsePagination(searchParams, {
      defaultPage: 1,
      defaultPageSize: 15,
      maxPageSize: 50,
    });

    const search = sanitizeField(searchParams.get("search"), 100);
    const categorySlug = sanitizeField(searchParams.get("categorySlug"), 100);
    const categoryId = sanitizeField(searchParams.get("categoryId"), 50);
    const wordCountKey = searchParams.get("wordCount") || "all";
    const status = searchParams.get("status") || "";
    const sortKey = searchParams.get("sort") || "last_update";
    const timeRange = searchParams.get("timeRange") || "all";

    // Build where clause
    const where: Record<string, unknown> = {};

    if (search) {
      // SQLite does not support mode: "insensitive" — use $queryRaw with COLLATE NOCASE
      // Escape LIKE wildcards to prevent user input from affecting query semantics
      const escaped = search.replace(/%/g, '\\%').replace(/_/g, '\\_');
      const novels = await db.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`SELECT id FROM Novel WHERE title LIKE ${'%' + escaped + '%'} COLLATE NOCASE ESCAPE '\\' OR author LIKE ${'%' + escaped + '%'} COLLATE NOCASE ESCAPE '\\' LIMIT 200`
      );
      if (novels.length > 0) {
        where.id = { in: novels.map((n) => n.id) };
      } else {
        // No matches — return empty result early
        return NextResponse.json({ novels: [], total: 0, page, pageSize, totalPages: 0 }, {
          headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' },
        });
      }
    }

    // Category filter: support both slug and id
    if (categorySlug) {
      where.category = { slug: categorySlug };
    } else if (categoryId) {
      where.categoryId = categoryId;
    }

    // Word count filter
    const wcRange = WORD_COUNT_RANGES[wordCountKey];
    if (wcRange) {
      const wcFilter: Record<string, unknown> = {};
      if (wcRange.min > 0) wcFilter.gte = wcRange.min;
      if (wcRange.max !== Infinity) wcFilter.lte = wcRange.max;
      if (Object.keys(wcFilter).length > 0) {
        where.wordCount = wcFilter;
      }
    }

    // Status filter
    if (status && (status === "ongoing" || status === "completed" || status === "hiatus")) {
      where.status = status;
    }

    // Time range filter for click-based rankings
    if (timeRange !== "all" && (sortKey === "weekly_clicks" || sortKey === "monthly_clicks")) {
      const now = new Date();
      const startDate = new Date();
      if (timeRange === "week") {
        startDate.setDate(now.getDate() - 7);
      } else if (timeRange === "month") {
        startDate.setMonth(now.getMonth() - 1);
      }
      where.updatedAt = { gte: startDate };
    }

    // Sort
    const sortConfig = SORT_MAP[sortKey] || SORT_MAP.last_update;

    const [novels, total] = await Promise.all([
      db.novel.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { [sortConfig.field]: sortConfig.direction },
        select: {
          id: true,
          title: true,
          author: true,
          description: true,
          coverUrl: true,
          coverPath: true,
          status: true,
          wordCount: true,
          category: {
            select: { id: true, name: true, slug: true, color: true, icon: true },
          },
          tags: {
            select: { tag: { select: { id: true, name: true, color: true } } },
          },
          _count: { select: { chapters: true } },
          clickCount: true,
          favoriteCount: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      db.novel.count({ where }),
    ]);

    return NextResponse.json({
      novels,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    }, {
      headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' },
    });
  } catch (error) {
    console.error("Public novels API error:", error);
    return apiError("获取小说列表失败", 500);
  }
});
