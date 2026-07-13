import { db } from "@/lib/db";
import { safeJson, sanitizeField, isPrismaError } from "@/lib/api-utils";
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
      return NextResponse.json({ error: "采集任务不存在" }, { status: 404 });
    }

    return NextResponse.json(task);
  } catch (error) {
    console.error("Get scrape task error:", error);
    return NextResponse.json({ error: "获取采集任务详情失败" }, { status: 500 });
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
      return NextResponse.json({ error: "请求数据格式错误" }, { status: 400 });
    }

    // Build update data outside the transaction for fields that don't depend on current state
    const updateData: Record<string, unknown> = {};

    if (body.progress !== undefined) {
      const p = parseFloat(body.progress);
      if (isNaN(p)) {
        return NextResponse.json({ error: "progress 必须是有效数字" }, { status: 400 });
      }
      updateData.progress = Math.min(100, Math.max(0, p));
    }
    if (body.currentStep !== undefined) {
      updateData.currentStep = String(body.currentStep).slice(0, 200);
    }
    const numFields = ['totalBooks', 'totalChapters', 'newBooks', 'newChapters', 'failedItems', 'skippedItems'] as const;
    for (const field of numFields) {
      if (body[field] !== undefined) {
        const v = Number(body[field]);
        if (!Number.isFinite(v) || v < 0) {
          return NextResponse.json({ error: `${field} 必须是非负数字` }, { status: 400 });
        }
        updateData[field] = v;
      }
    }
    if (body.errorMessage !== undefined) updateData.errorMessage = sanitizeField(body.errorMessage, 2000);
    if (body.resultUrl !== undefined) {
      const val = sanitizeField(body.resultUrl, 500);
      if (val) {
        const { isSafeUrl } = await import("@/lib/sanitize");
        if (!isSafeUrl(val)) {
          return NextResponse.json({ error: "resultUrl格式不合法" }, { status: 400 });
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
          if (!validStatuses.includes(body.status)) {
            throw new Error(`INVALID_STATUS:${body.status}`);
          }
          // Enforce state machine transitions
          const allowed = validTransitions[task.status] || [];
          if (!allowed.includes(body.status)) {
            throw new Error(`INVALID_TRANSITION:${task.status}:${body.status}`);
          }
          txUpdateData.status = body.status;
          if (body.status === "running" && !task.startedAt) {
            txUpdateData.startedAt = new Date();
          }
          if (["completed", "failed", "cancelled"].includes(body.status)) {
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
        return NextResponse.json({ error: `无效的任务状态: ${msg.split(":")[1]}` }, { status: 400 });
      }
      if (msg.startsWith("INVALID_TRANSITION:")) {
        const [, from, to] = msg.split(":");
        return NextResponse.json({ error: `不允许从 "${from}" 转换到 "${to}"` }, { status: 400 });
      }
      if (isPrismaError(error, "P2025")) {
        return NextResponse.json({ error: "采集任务不存在" }, { status: 404 });
      }
      throw error;
    }

    return NextResponse.json(taskResult);
  } catch (error) {
    console.error("Update scrape task error:", error);
    return NextResponse.json({ error: "更新采集任务失败" }, { status: 500 });
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
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "NOT_FOUND") {
      return NextResponse.json({ error: "采集任务不存在" }, { status: 404 });
    }
    if (error instanceof Error && error.message === "TASK_RUNNING") {
      return NextResponse.json({ error: "运行中的任务无法删除" }, { status: 400 });
    }
    if (isPrismaError(error, "P2025")) {
      return NextResponse.json({ error: "采集任务不存在" }, { status: 404 });
    }
    console.error("Delete scrape task error:", error);
    return NextResponse.json({ error: "删除采集任务失败" }, { status: 500 });
  }
});