import { db } from "@/lib/db";
import { NextResponse } from "next/server";
import { getCached, setCache } from "@/lib/cache";
import { withAuth } from "@/lib/api-auth";

const DASHBOARD_CACHE_KEY = "dashboard:stats";
const DASHBOARD_CACHE_TTL = 30 * 1000; // 30 seconds

export const GET = withAuth(async function GET() {
  try {
    // Check cache first
    const cached = getCached(DASHBOARD_CACHE_KEY);
    if (cached) {
      return NextResponse.json(cached);
    }

    // Parallelize all independent database queries
    const [totalNovels, totalChapters, totalWords, totalCategories, recentNovels, statusGroups] =
      await Promise.all([
        db.novel.count(),
        db.chapter.count(),
        db.novel.aggregate({ _sum: { wordCount: true } }),
        db.category.count(),
        db.novel.findMany({
          take: 8,
          orderBy: { updatedAt: "desc" },
          include: {
            category: true,
            _count: { select: { chapters: true } },
          },
        }),
        db.novel.groupBy({
          by: ["status"],
          _count: { status: true },
        }),
      ]);

    const statusDistribution = statusGroups.map((g) => ({
      status: g.status,
      count: g._count.status,
    }));

    const data = {
      totalNovels,
      totalChapters,
      totalWords: totalWords._sum.wordCount || 0,
      totalCategories,
      recentNovels,
      statusDistribution,
    };

    // Cache the result
    setCache(DASHBOARD_CACHE_KEY, data, DASHBOARD_CACHE_TTL);

    return NextResponse.json(data);
  } catch (error) {
    console.error("Dashboard stats error:", error);
    return NextResponse.json({ error: "获取统计数据失败" }, { status: 500 });
  }
});