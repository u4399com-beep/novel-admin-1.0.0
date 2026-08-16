import { db } from "@/lib/db";
import { apiError, apiSuccess, isPrismaError } from "@/lib/api-utils";
import { withAuth } from "@/lib/api-auth";
import { NextRequest } from "next/server";

// POST /api/scrape-tasks/[id]/cancel - Cancel a running/pending task
export const POST = withAuth(async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const task = await db.scrapeTask.findUnique({
      where: { id },
      select: { id: true, status: true },
    });

    if (!task) {
      return apiError("采集任务不存在", 404);
    }

    if (!["running", "pending"].includes(task.status)) {
      return apiError("只有运行中或等待中的任务才能取消", 400);
    }

    await db.scrapeTask.update({
      where: { id },
      data: {
        status: "cancelled",
        completedAt: new Date(),
      },
    });

    return apiSuccess({ message: "任务已取消" });
  } catch (error) {
    if (isPrismaError(error, "P2025")) {
      return apiError("采集任务不存在", 404);
    }
    return apiError("取消任务失败");
  }
});
