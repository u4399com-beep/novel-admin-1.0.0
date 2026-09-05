import { db } from "@/lib/db";
import { apiError, apiSuccess, isPrismaError } from "@/lib/api-utils";
import { withAuth, rateLimit, getClientIp } from "@/lib/api-auth";
import { SCRAPER_SERVICE_URL, getScraperServiceHeaders } from "@/lib/constants";
import { NextRequest } from "next/server";

// Retry rate limit: 10 per minute
const RETRY_CAPACITY = 10;
const RETRY_REFILL = 10 / 60;

// POST /api/scrape-tasks/[id]/retry - Retry a failed/cancelled task
export const POST = withAuth(async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ip = getClientIp(_request);
    const rl = rateLimit(`task-retry:${ip}`, {
      capacity: RETRY_CAPACITY,
      refillRate: RETRY_REFILL,
    });
    if (!rl.allowed) {
      return apiError("重试操作过于频繁，请稍后再试", 429);
    }

    const { id } = await params;

    const originalTask = await db.scrapeTask.findUnique({
      where: { id },
      select: { id: true, ruleId: true, mode: true, status: true },
    });

    if (!originalTask) {
      return apiError("采集任务不存在", 404);
    }

    if (!["failed", "cancelled"].includes(originalTask.status)) {
      return apiError("只有失败或已取消的任务才能重试", 400);
    }

    const task = await db.scrapeTask.create({
      data: {
        ruleId: originalTask.ruleId,
        mode: originalTask.mode,
        status: "pending",
      },
      include: { rule: { select: { id: true, name: true } } },
    });

    // Auto-trigger scraper-service
    const scraperUrl = SCRAPER_SERVICE_URL;
    const triggerTaskId = task.id;
    void (async () => {
      try {
        const res = await fetch(`${scraperUrl}/execute-task`, {
          method: "POST",
          headers: getScraperServiceHeaders(),
          body: JSON.stringify({ taskId: triggerTaskId }),
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) {
          await db.scrapeTask.updateMany({
            where: { id: triggerTaskId, status: "pending" },
            data: { status: "failed", errorMessage: `触发采集服务失败: Scraper service responded with ${res.status}`, completedAt: new Date() },
          });
        }
      } catch (err) {
        console.error(`[Retry Task] Failed to auto-trigger task ${triggerTaskId}:`, err);
        try {
          const safeMsg = err instanceof Error
            ? err.message.replace(/https?:\/\/[^\s]+/g, "[URL]")
            : "未知错误";
          await db.scrapeTask.updateMany({
            where: { id: triggerTaskId, status: "pending" },
            data: { status: "failed", errorMessage: `触发采集服务失败: ${safeMsg}`, completedAt: new Date() },
          });
        } catch (dbErr) {
          console.error(`[Retry Task] Failed to update task ${triggerTaskId} status after trigger failure:`, dbErr);
        }
      }
    })();

    return apiSuccess({ taskId: task.id });
  } catch (error) {
    if (isPrismaError(error, "P2025")) {
      return apiError("采集任务不存在", 404);
    }
    return apiError("重试任务失败");
  }
});
