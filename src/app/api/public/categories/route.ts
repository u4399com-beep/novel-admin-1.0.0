import { db } from "@/lib/db";
import { NextResponse } from "next/server";

/**
 * Public categories API — no auth required.
 * Returns all categories with novel count, slug, and icon.
 */
export async function GET() {
  try {
    const categories = await db.category.findMany({
      orderBy: { sortOrder: "asc" },
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
    });
    return NextResponse.json(categories);
  } catch (error) {
    console.error("Public categories API error:", error);
    return NextResponse.json({ error: "获取分类失败" }, { status: 500 });
  }
}
