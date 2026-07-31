import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

/**
 * Public novel listing API — no auth required.
 * Returns paginated novels with category info and chapter count.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const rawPage = searchParams.get("page") || "1";
    const rawSize = searchParams.get("pageSize") || "12";
    const page = Math.max(1, parseInt(rawPage, 10) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(rawSize, 10) || 12));
    const skip = (page - 1) * pageSize;

    const search = (searchParams.get("search") || "").trim().slice(0, 100);
    const categoryId = searchParams.get("categoryId") || "";
    const status = searchParams.get("status") || "";

    const where: Record<string, unknown> = {};
    if (search) {
      where.OR = [
        { title: { contains: search } },
        { author: { contains: search } },
      ];
    }
    if (categoryId) {
      where.categoryId = categoryId;
    }
    if (status) {
      where.status = status;
    }

    const [novels, total] = await Promise.all([
      db.novel.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { updatedAt: "desc" },
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
            select: { id: true, name: true, color: true },
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
    return NextResponse.json({ error: "获取小说列表失败" }, { status: 500 });
  }
}
