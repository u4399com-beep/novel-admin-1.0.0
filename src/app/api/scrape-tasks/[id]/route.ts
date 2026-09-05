import { db } from "@/lib/db";
import { safeJson, sanitizeField, isPrismaError, apiError, apiDeleted } from "@/lib/api-utils";
import { isSafeUrl } from "@/lib/sanitize";
import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";

// GET /api/scrape-tasks/[id] - Get a single scrape task
export const GET = withAuth(async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const task = await db.scrapeTask.findUnique({
      where: { id },
      include: {
        rule: {
          select: {
            id: true, name: true, enabled: true,
            listUrl: true, scrapeMode: true, engine: true,
            storageMode: true, threadCount: true,
          },
        },
        logs: {
          select: { id: true, level: true, message: true, url: true, createdAt: true },
          orderBy: { createdAt: "desc" },
          take: 50,
        },
      },
    });

    if (!task) {
      return apiError("采集任务不存在", 404);
    }

    return NextResponse.json(task);
  } catch (error) {
    console.error("Get scrape task error:", error);
    return apiError("获取采集任务详情失败", 500);
  }
});

// PUT /api/scrape-tasks/[id] - Update a scrape task (progress tracking)
export const PUT = withAuth(async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    let body;
    try {
      body = await safeJson(request);
    } catch {
      return apiError("请求数据格式错误", 400);
    }

    // Build update data outside the transaction for fields that don't depend on current state
    const updateData: Record<string, unknown> = {};

    if (body.progress !== undefined) {
      const p = parseFloat(String(body.progress));
      if (isNaN(p)) {
        return apiError("progress 必须是有效数字", 400);
      }
      updateData.progress = Math.min(100, Math.max(0, p));
    }
    if (body.currentStep !== undefined) {
      updateData.currentStep = sanitizeField(String(body.currentStep), 200);
    }
    const MAX_COUNTER_VALUE = 10_000_000;
    const numFields = ['totalBooks', 'totalChapters', 'newBooks', 'newChapters', 'failedItems', 'skippedItems'] as const;
    for (const field of numFields) {
      if (body[field] !== undefined) {
        const v = Number(body[field]);
        if (!Number.isFinite(v) || v < 0) {
          return apiError(`${field} 必须是非负数字`, 400);
        }
        if (v > MAX_COUNTER_VALUE) {
          return apiError(`${field} 不能超过${MAX_COUNTER_VALUE}`, 400);
        }
        updateData[field] = v;
      }
    }
    if (body.errorMessage !== undefined) updateData.errorMessage = sanitizeField(body.errorMessage, 2000);
    if (body.lastHeartbeatAt !== undefined) {
      const d = new Date(body.lastHeartbeatAt as string | number);
      if (!isNaN(d.getTime())) {
        updateData.lastHeartbeatAt = d;
      }
    }
    if (body.resultUrl !== undefined) {
      const val = sanitizeField(body.resultUrl, 500);
      if (val) {
        // isSafeUrl is statically imported at the top of this file
        if (!isSafeUrl(val)) {
          return apiError("resultUrl格式不合法", 400);
        }
      }
      updateData.resultUrl = val;
    }

    // Wrap status transition check + update in a transaction to prevent TOCTOU races
    let taskResult: Record<string, unknown> | null = null;

    try {
      taskResult = await db.$transaction(async (tx) => {
        const task = await tx.scrapeTask.findUniqueOrThrow({ where: { id } });

        const validStatuses = ["pending", "running", "completed", "failed", "cancelled"];
        // Valid state transitions to prevent invalid status changes
        const validTransitions: Record<string, string[]> = {
          pending: ["running", "cancelled", "failed"],
          running: ["completed", "failed", "cancelled"],
          completed: [],
          failed: ["pending", "running"],  // allow retry
          cancelled: [],
        };

        const txUpdateData: Record<string, unknown> = { ...updateData };

        if (body.status !== undefined) {
          if (!validStatuses.includes(body.status as string)) {
            throw new Error(`INVALID_STATUS:${String(body.status)}`);
          }
          // Enforce state machine transitions
          const allowed = validTransitions[task.status] || [];
          if (!allowed.includes(body.status as string)) {
            throw new Error(`INVALID_TRANSITION:${task.status}:${body.status}`);
          }
          txUpdateData.status = body.status;
          if (body.status === "running" && !task.startedAt) {
            txUpdateData.startedAt = new Date();
          }
          if (["completed", "failed", "cancelled"].includes(body.status as string)) {
            txUpdateData.completedAt = new Date();
          }
        }

        return tx.scrapeTask.update({
          where: { id },
          data: txUpdateData,
          include: { rule: { select: { id: true, name: true } } },
        });
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.startsWith("INVALID_STATUS:")) {
        return apiError(`无效的任务状态: ${msg.split(":")[1]}`, 400);
      }
      if (msg.startsWith("INVALID_TRANSITION:")) {
        const [, from, to] = msg.split(":");
        return apiError(`不允许从 "${from}" 转换到 "${to}"`, 400);
      }
      if (isPrismaError(error, "P2025")) {
        return apiError("采集任务不存在", 404);
      }
      throw error;
    }

    return NextResponse.json(taskResult);
  } catch (error) {
    console.error("Update scrape task error:", error);
    return apiError("更新采集任务失败", 500);
  }
});

// DELETE /api/scrape-tasks/[id] - Delete a scrape task
export const DELETE = withAuth(async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await db.$transaction(async (tx) => {
      const task = await tx.scrapeTask.findUnique({ where: { id } });
      if (!task) {
        throw new Error("NOT_FOUND");
      }
      if (task.status === "running") {
        throw new Error("TASK_RUNNING");
      }
      await tx.scrapeTask.delete({ where: { id } });
    });
    return apiDeleted();
  } catch (error) {
    if (error instanceof Error && error.message === "NOT_FOUND") {
      return apiError("采集任务不存在", 404);
    }
    if (error instanceof Error && error.message === "TASK_RUNNING") {
      return apiError("运行中的任务无法删除", 400);
    }
    if (isPrismaError(error, "P2025")) {
      return apiError("采集任务不存在", 404);
    }
    console.error("Delete scrape task error:", error);
    return apiError("删除采集任务失败", 500);
  }
});