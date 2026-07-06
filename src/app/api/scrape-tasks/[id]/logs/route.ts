import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

// POST /api/scrape-tasks/[id]/logs - Create a scrape log entry
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: taskId } = await params;
    const body = await request.json();
    const { level, message, url, detail } = body;

    if (!taskId) {
      return NextResponse.json({ error: "任务ID不能为空" }, { status: 400 });
    }
    if (!message?.trim()) {
      return NextResponse.json({ error: "日志消息不能为空" }, { status: 400 });
    }

    const validLevels = ["info", "warn", "error", "success"];
    const logLevel = validLevels.includes(level) ? level : "info";

    const log = await db.scrapeLog.create({
      data: {
        taskId,
        level: logLevel,
        message: String(message).slice(0, 5000),
        url: url?.trim()?.slice(0, 2000) || null,
        detail: detail?.trim()?.slice(0, 10000) || null,
      },
    });

    return NextResponse.json(log, { status: 201 });
  } catch (error) {
    console.error("Create scrape log error:", error);
    return NextResponse.json({ error: "创建采集日志失败" }, { status: 500 });
  }
}

// GET /api/scrape-tasks/[id]/logs - Get scrape logs for a task
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: taskId } = await params;
    const { searchParams } = new URL(_request.url);
    const level = searchParams.get("level") || "";
    const limit = Math.min(Math.max(1, parseInt(searchParams.get("limit") || "100") || 100), 500);

    const where: Record<string, unknown> = { taskId };
    if (level) {
      where.level = level;
    }

    const logs = await db.scrapeLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    return NextResponse.json(logs);
  } catch (error) {
    console.error("Get scrape logs error:", error);
    return NextResponse.json({ error: "获取采集日志失败" }, { status: 500 });
  }
}