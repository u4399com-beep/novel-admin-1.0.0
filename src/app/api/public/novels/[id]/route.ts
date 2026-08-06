import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";
import { withPublicRateLimit } from "@/lib/api-auth";
import { apiError } from "@/lib/api-utils"

/**
 * Public novel detail API — no auth required.
 * Returns novel with category, tags, and chapter count.
 */
export const GET = withPublicRateLimit(async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const novel = await db.novel.findUnique({
      where: { id },
      include: {
        category: { select: { id: true, name: true, slug: true, color: true, icon: true } },
        tags: { include: { tag: { select: { id: true, name: true, color: true } } } },
        _count: { select: { chapters: true } },
      },
    });

    if (!novel) {
      return apiError("小说不存在", 404);
    }

    // Transform tags to a flat array
    const { tags, ...rest } = novel;
    const tagList = tags.map((t) => t.tag);

    return NextResponse.json({ ...rest, tags: tagList });
  } catch (error) {
    console.error("Public novel detail API error:", error);
    return apiError("获取小说详情失败", 500);
  }
});
