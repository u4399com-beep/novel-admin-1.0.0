import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

// GET /api/scrape-tasks/[id] - Get a single scrape task
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const task = await db.scrapeTask.findUnique({
      where: { id },
      include: {
        rule: true,
        logs: {
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
}

// PUT /api/scrape-tasks/[id] - Update a scrape task (progress tracking)
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();

    const task = await db.scrapeTask.findUnique({ where: { id } });
    if (!task) {
      return NextResponse.json({ error: "采集任务不存在" }, { status: 404 });
    }

    const validStatuses = ["pending", "running", "completed", "failed", "cancelled"];
    const updateData: Record<string, unknown> = {};

    if (body.status !== undefined) {
      if (!validStatuses.includes(body.status)) {
        return NextResponse.json({ error: "无效的任务状态" }, { status: 400 });
      }
      updateData.status = body.status;
      if (body.status === "running" && !task.startedAt) {
        updateData.startedAt = new Date();
      }
      if (["completed", "failed", "cancelled"].includes(body.status)) {
        updateData.completedAt = new Date();
      }
    }

    if (body.progress !== undefined) {
      updateData.progress = Math.min(100, Math.max(0, Number(body.progress)));
    }
    if (body.currentStep !== undefined) {
      updateData.currentStep = String(body.currentStep).slice(0, 200);
    }
    if (body.totalBooks !== undefined) updateData.totalBooks = Math.max(0, Number(body.totalBooks));
    if (body.totalChapters !== undefined) updateData.totalChapters = Math.max(0, Number(body.totalChapters));
    if (body.newBooks !== undefined) updateData.newBooks = Math.max(0, Number(body.newBooks));
    if (body.newChapters !== undefined) updateData.newChapters = Math.max(0, Number(body.newChapters));
    if (body.failedItems !== undefined) updateData.failedItems = Math.max(0, Number(body.failedItems));
    if (body.skippedItems !== undefined) updateData.skippedItems = Math.max(0, Number(body.skippedItems));
    if (body.errorMessage !== undefined) updateData.errorMessage = String(body.errorMessage).slice(0, 2000);
    if (body.resultUrl !== undefined) updateData.resultUrl = String(body.resultUrl).slice(0, 500);

    const updated = await db.scrapeTask.update({
      where: { id },
      data: updateData,
      include: { rule: { select: { id: true, name: true } } },
    });

    return NextResponse.json(updated);
  } catch (error) {
    console.error("Update scrape task error:", error);
    return NextResponse.json({ error: "更新采集任务失败" }, { status: 500 });
  }
}

// DELETE /api/scrape-tasks/[id] - Delete a scrape task
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const task = await db.scrapeTask.findUnique({ where: { id } });
    if (!task) {
      return NextResponse.json({ error: "采集任务不存在" }, { status: 404 });
    }
    if (task.status === "running") {
      return NextResponse.json({ error: "运行中的任务无法删除" }, { status: 400 });
    }
    await db.scrapeTask.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Delete scrape task error:", error);
    return NextResponse.json({ error: "删除采集任务失败" }, { status: 500 });
  }
}