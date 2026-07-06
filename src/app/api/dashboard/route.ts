import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

export async function GET() {
  try {
    const totalNovels = await db.novel.count();
    const totalChapters = await db.chapter.count();
    const totalWords = await db.novel.aggregate({ _sum: { wordCount: true } });
    const totalCategories = await db.category.count();

    const recentNovels = await db.novel.findMany({
      take: 8,
      orderBy: { updatedAt: "desc" },
      include: {
        category: true,
        _count: { select: { chapters: true } },
      },
    });

    // Status distribution
    const statusGroups = await db.novel.groupBy({
      by: ["status"],
      _count: { status: true },
    });

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