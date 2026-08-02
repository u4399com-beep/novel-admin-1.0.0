import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

// ─── 23qb.net 字数区间映射 ─────────────────────────────────────────
const WORD_COUNT_RANGES: Record<string, { min: number; max: number }> = {
  all:        { min: 0,     max: Infinity },
  under_30w:  { min: 0,     max: 300000 },
  "30w_50w":  { min: 300000, max: 500000 },
  "50w_100w":  { min: 500000, max: 1000000 },
  "100w_200w": { min: 1000000, max: 2000000 },
  "200w_300w": { min: 2000000, max: 3000000 },
  over_400w:  { min: 4000000, max: Infinity },
};

// ─── 23qb.net 排序映射 ─────────────────────────────────────────────
const SORT_MAP: Record<string, { field: string; direction: "asc" | "desc" }> = {
  last_update:  { field: "updatedAt",       direction: "desc" },
  new_entry:    { field: "createdAt",       direction: "desc" },
  weekly_click:  { field: "updatedAt", direction: "desc" },
  monthly_click: { field: "updatedAt", direction: "desc" },
  weekly_rec:    { field: "updatedAt", direction: "desc" },
  monthly_rec:   { field: "updatedAt", direction: "desc" },
  favorites:     { field: "updatedAt", direction: "desc" },
  new_hot:       { field: "createdAt", direction: "desc" },
};

/**
 * Public novel listing API — no auth required.
 * Cloned from 23qb.net filter system:
 *   - categorySlug: 分类筛选
 *   - wordCount: 字数筛选 (all|under_30w|30w_50w|50w_100w|100w_200w|200w_300w|over_400w)
 *   - status: 状态筛选 (ongoing|completed|"")
 *   - sort: 排序方式 (last_update|new_entry|new_hot|weekly_click|...)
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const rawPage = searchParams.get("page") || "1";
    const rawSize = searchParams.get("pageSize") || "15";
    const page = Math.max(1, parseInt(rawPage, 10) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(rawSize, 10) || 15));
    const skip = (page - 1) * pageSize;

    const search = (searchParams.get("search") || "").trim().slice(0, 100);
    const categorySlug = searchParams.get("categorySlug") || "";
    const categoryId = searchParams.get("categoryId") || "";
    const wordCountKey = searchParams.get("wordCount") || "all";
    const status = searchParams.get("status") || "";
    const sortKey = searchParams.get("sort") || "last_update";

    // Build where clause
    const where: Record<string, unknown> = {};

    if (search) {
      where.OR = [
        { title: { contains: search } },
        { author: { contains: search } },
      ];
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
          _count: { select: { chapters: true } },
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
    });
  } catch (error) {
    console.error("Public novels API error:", error);
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: "获取小说列表失败", detail: msg }, { status: 500 });
  }
}
