import { db } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET() {
  try {
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

    return NextResponse.json({
      totalNovels,
      totalChapters,
      totalWords: totalWords._sum.wordCount || 0,
      totalCategories,
      recentNovels,
      statusDistribution,
    });
  } catch (error) {
    console.error("Dashboard stats error:", error);
    return NextResponse.json({ error: "获取统计数据失败" }, { status: 500 });
  }
}