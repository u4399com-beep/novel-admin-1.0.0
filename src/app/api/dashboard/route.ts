import { db } from "@/lib/db";
import { NextResponse } from "next/server";
import { getOrCompute } from "@/lib/cache";
import { withAuth } from "@/lib/api-auth";
import { apiError } from "@/lib/api-utils";

const DASHBOARD_CACHE_KEY = "dashboard:stats";
const DASHBOARD_CACHE_TTL = 30 * 1000; // 30 seconds

export const GET = withAuth(async function GET() {
  try {
    const data = await getOrCompute(DASHBOARD_CACHE_KEY, DASHBOARD_CACHE_TTL, async () => {
      // SQLite-compatible UNION ALL query (no PostgreSQL ::bigint cast)
      const counts = await db.$queryRaw<Array<{ kind: string; cnt: number }>>(`
        SELECT 'novels' as kind, COUNT(*) as cnt FROM Novel
        UNION ALL
        SELECT 'chapters', COUNT(*) FROM Chapter
        UNION ALL
        SELECT 'categories', COUNT(*) FROM Category
        UNION ALL
        SELECT 'tags', COUNT(*) FROM Tag
        UNION ALL
        SELECT 'favorites' as kind, COALESCE(SUM("favoriteCount"), 0) as cnt FROM Novel
      `);

      const getCount = (kind: string) => Number(counts.find((r) => r.kind === kind)?.cnt ?? 0);
      const totalNovels = getCount('novels');
      const totalChapters = getCount('chapters');
      const totalCategories = getCount('categories');
      const totalTags = getCount('tags');
      const totalFavorites = getCount('favorites');

      // Run remaining queries in parallel
      const [totalWords, recentNovels, statusGroups] = await Promise.all([
        db.novel.aggregate({ _sum: { wordCount: true } }),
        db.novel.findMany({
          take: 8,
          orderBy: { updatedAt: "desc" },
          include: {
            category: { select: { id: true, name: true, color: true, slug: true, icon: true } },
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

      return {
        totalNovels,
        totalChapters,
        totalWords: totalWords._sum.wordCount || 0,
        totalCategories,
        totalTags,
        totalFavorites,
        recentNovels,
        statusDistribution,
      };
    });

    return NextResponse.json(data);
  } catch (error) {
    console.error("Dashboard stats error:", error);
    return apiError("获取统计数据失败", 500);
  }
});