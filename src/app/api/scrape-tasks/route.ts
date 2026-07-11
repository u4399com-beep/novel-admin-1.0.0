import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";
import { parsePagination, safeJson } from "@/lib/api-utils";
import { withAuth } from "@/lib/api-auth";

const VALID_STATUSES = ["pending", "running", "completed", "failed", "cancelled"];

// GET /api/scrape-tasks - List all scrape tasks
export const GET = withAuth(async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const { page, pageSize, skip } = parsePagination(searchParams);
    const status = searchParams.get("status") || "";

    const where: Record<string, unknown> = {};
    if (status) {
      if (!VALID_STATUSES.includes(status)) {
        return NextResponse.json({ error: "无效的任务状态筛选值" }, { status: 400 });
      }
      where.status = status;
    }

    const [tasks, total] = await Promise.all([
      db.scrapeTask.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { createdAt: "desc" },
        include: {
          rule: { select: { id: true, name: true } },
        },
      }),
      db.scrapeTask.count({ where }),
    ]);

    return NextResponse.json({
      tasks,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (error) {
    console.error("List scrape tasks error:", error);
    return NextResponse.json({ error: "获取采集任务列表失败" }, { status: 500 });
  }
});

// POST /api/scrape-tasks - Create a new scrape task and auto-trigger execution
export const POST = withAuth(async function POST(request: NextRequest) {
  try {
    let body;
    try {
      body = await safeJson(request);
    } catch {
      return NextResponse.json({ error: "请求数据格式错误" }, { status: 400 });
    }
    const { ruleId, mode, autoStart } = body;

    if (!ruleId) {
      return NextResponse.json({ error: "规则ID不能为空" }, { status: 400 });
    }

    // Verify the rule exists
    const rule = await db.scrapeRule.findUnique({ where: { id: ruleId } });
    if (!rule) {
      return NextResponse.json({ error: "采集规则不存在" }, { status: 404 });
    }

    const validModes = ["incremental", "full"];
    const taskMode = validModes.includes(mode) ? mode : (rule.scrapeMode || "incremental");

    const task = await db.scrapeTask.create({
      data: {
        ruleId,
        mode: taskMode,
        status: "pending",
      },
      include: {
        rule: { select: { id: true, name: true } },
      },
    });

    // Auto-trigger scraper-service to execute the task (fire-and-forget)
    // Default: autoStart = true unless explicitly set to false
    const shouldAutoStart = autoStart !== false;
    if (shouldAutoStart) {
      const scraperUrl = process.env.SCRAPER_SERVICE_URL || "http://localhost:3099";
      fetch(`${scraperUrl}/execute-task?XTransformPort=3099`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.SCRAPER_SERVICE_TOKEN || ""}`,
        },
        body: JSON.stringify({ taskId: task.id }),
        signal: AbortSignal.timeout(5000),
      }).catch((err) => {
        console.error(`[Scrape Task] Failed to auto-trigger task ${task.id}:`, err);
        // Task remains "pending" — user can retry manually
      });
    }

    return NextResponse.json(task, { status: 201 });
  } catch (error) {
    console.error("Create scrape task error:", error);
    return NextResponse.json({ error: "创建采集任务失败" }, { status: 500 });
  }
});