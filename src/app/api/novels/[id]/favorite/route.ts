import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { isPrismaError, apiError, safeJson } from "@/lib/api-utils";

// POST /api/novels/[id]/favorite - Toggle favorite count
export const POST = withAuth(async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    let body;
    try {
      body = await safeJson(request);
    } catch {
      return apiError('请求数据格式错误', 400);
    }
    const { favorite } = body;

    if (typeof favorite !== "boolean") {
      return apiError("favorite 必须是布尔值", 400);
    }

    const novel = await db.novel.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!novel) {
      return apiError("小说不存在", 404);
    }

    const updated = await db.novel.update({
      where: { id },
      data: {
        favoriteCount: {
          [favorite ? "increment" : "decrement"]: 1,
        },
      },
      select: { favoriteCount: true },
    });

    return NextResponse.json({ favoriteCount: Math.max(0, updated.favoriteCount) });
  } catch (error: unknown) {
    console.error("Toggle favorite error:", error);
    if (isPrismaError(error, "P2025")) {
      return apiError("小说不存在", 404);
    }
    return apiError("操作失败", 500);
  }
});
