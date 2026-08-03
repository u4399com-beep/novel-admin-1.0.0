import { db } from "@/lib/db";
import { NextResponse } from "next/server";
import { withPublicRateLimit } from "@/lib/api-auth";
import { getOrCompute } from "@/lib/cache";

/**
 * Public categories API — no auth required.
 * Returns all categories with novel count, slug, and icon.
 * Shares cache with admin /api/categories so invalidation works.
 */
export const GET = withPublicRateLimit(async function GET() {
  try {
    const categories = await getOrCompute("categories:list", 60_000, () =>
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
    return NextResponse.json(categories);
  } catch (error) {
    console.error("Public categories API error:", error);
    return NextResponse.json({ error: "获取分类失败" }, { status: 500 });
  }
});
