import { db } from "@/lib/db";
import { apiError, apiSuccess, safeJson } from "@/lib/api-utils";
import { withAuth } from "@/lib/api-auth";
import { NextRequest } from "next/server";

// POST /api/scrape-tasks/batch-delete - Batch delete non-running tasks
export const POST = withAuth(async function POST(request: NextRequest) {
  try {
    let body: { taskIds?: unknown };
    try {
      body = await safeJson(request);
    } catch {
      return apiError("请求数据格式错误", 400);
    }

    const { taskIds } = body;

    if (!Array.isArray(taskIds) || taskIds.length === 0) {
      return apiError("taskIds 必须为非空数组", 400);
    }

    if (taskIds.length > 100) {
      return apiError("单次最多删除100条任务", 400);
    }

    const validIds = taskIds.filter(
      (id): id is string => typeof id === "string" && id.trim().length > 0
    );

    if (validIds.length === 0) {
      return apiError("未提供有效的任务ID", 400);
    }

    // Find running tasks to skip
    const runningTasks = await db.scrapeTask.findMany({
      where: { id: { in: validIds }, status: "running" },
      select: { id: true },
    });

    const runningIds = new Set(runningTasks.map((t) => t.id));
    const idsToDelete = validIds.filter((id) => !runningIds.has(id));

    let deleted = 0;
    if (idsToDelete.length > 0) {
      const result = await db.scrapeTask.deleteMany({
        where: { id: { in: idsToDelete } },
      });
      deleted = result.count;
    }

    const skipped = runningIds.size;

    return apiSuccess({ deleted, skipped });
  } catch {
    return apiError("批量删除任务失败");
  }
});
