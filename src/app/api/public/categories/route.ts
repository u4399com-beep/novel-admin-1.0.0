import { db } from "@/lib/db";
import { NextResponse } from "next/server";
import { withPublicRateLimit } from "@/lib/api-auth";
import { getOrCompute } from "@/lib/cache";
import { apiError } from "@/lib/api-utils"

/**
 * Public categories API — no auth required.
 * Returns all categories with novel count, slug, and icon.
 * Uses cache key "categories:public" (vs "categories:admin") to avoid shape collision.
 * Both are invalidated by "categories:*" wildcard.
 */
export const GET = withPublicRateLimit(async function GET() {
  try {
    const categories = await getOrCompute("categories:public", 60_000, () =>
      db.category.findMany({
        orderBy: { sortOrder: "asc" },
        take: 500,
        select: {
          id: true,
          name: true,
          slug: true,
          description: true,
          color: true,
          icon: true,
          sortOrder: true,
          _count: { select: { novels: true } },
        },
      })
    );
    return NextResponse.json(categories, {
      headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' },
    });
  } catch (error) {
    console.error("Public categories API error:", error);
    return apiError("获取分类失败", 500);
  }
});
