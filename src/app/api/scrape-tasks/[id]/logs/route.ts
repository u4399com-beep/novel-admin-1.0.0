import { db } from "@/lib/db";
import { safeJson, sanitizeField } from "@/lib/api-utils";
import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";

// POST /api/scrape-tasks/[id]/logs - Create a scrape log entry
export const POST = withAuth(async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: taskId } = await params;
    let body;
    try {
      body = await safeJson(request);
    } catch {
      return NextResponse.json({ error: "请求数据格式错误" }, { status: 400 });
    }
    const { level, message, url, detail } = body;

    if (!taskId) {
      return NextResponse.json({ error: "任务ID不能为空" }, { status: 400 });
    }

    // Verify task exists
    const task = await db.scrapeTask.findUnique({ where: { id: taskId }, select: { id: true } });
    if (!task) {
      return NextResponse.json({ error: "采集任务不存在" }, { status: 404 });
    }

    const sanitizedMessage = sanitizeField(message, 5000);
    if (!sanitizedMessage) {
      return NextResponse.json({ error: "日志消息不能为空" }, { status: 400 });
    }

    const validLevels = ["info", "warn", "error", "success"];
    if (!validLevels.includes(level)) {
      return NextResponse.json({ error: `无效的日志级别: ${level}` }, { status: 400 });
    }

    const log = await db.scrapeLog.create({
      data: {
        taskId,
        level: level,
        message: sanitizedMessage,
        url: sanitizeField(url, 2000) || null,
        detail: sanitizeField(detail, 10000) || null,
      },
    });

    return NextResponse.json(log, { status: 201 });
  } catch (error) {
    console.error("Create scrape log error:", error);
    return NextResponse.json({ error: "创建采集日志失败" }, { status: 500 });
  }
});

// GET /api/scrape-tasks/[id]/logs - Get scrape logs for a task
export const GET = withAuth(async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: taskId } = await params;
    const { searchParams } = new URL(_request.url);
    const level = searchParams.get("level") || "";
    const validLevels = ["info", "warn", "error", "success"];
    if (level && !validLevels.includes(level)) {
      return NextResponse.json({ error: "无效的日志级别" }, { status: 400 });
    }
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
});