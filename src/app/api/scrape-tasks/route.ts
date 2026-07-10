import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";
import { parsePagination } from "@/lib/api-utils";

const VALID_STATUSES = ["pending", "running", "completed", "failed", "cancelled"];

// GET /api/scrape-tasks - List all scrape tasks
export async function GET(request: NextRequest) {
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
}

// POST /api/scrape-tasks - Create a new scrape task
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { ruleId, mode } = body;

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

    return NextResponse.json(task, { status: 201 });
  } catch (error) {
    console.error("Create scrape task error:", error);
    return NextResponse.json({ error: "创建采集任务失败" }, { status: 500 });
  }
}