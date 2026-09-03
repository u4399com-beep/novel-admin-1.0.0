import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";
import { parsePagination, safeJson, apiError, apiSuccess } from "@/lib/api-utils";
import { withAuth, rateLimit, getClientIp } from "@/lib/api-auth";
import { paginatedList } from "@/lib/crud-helpers";
import { SCRAPER_SERVICE_URL, getScraperServiceHeaders } from "@/lib/constants";

const VALID_STATUSES = ["pending", "running", "completed", "failed", "cancelled"];
const VALID_TASK_MODES = ["incremental", "full"];

// Dedicated rate limit for task creation: 5 tasks per minute
// capacity=5, refillRate=5/60≈0.0833 tokens/sec
const TASK_CREATE_CAPACITY = 5;
const TASK_CREATE_REFILL = 5 / 60;

// GET /api/scrape-tasks - List all scrape tasks
export const GET = withAuth(async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const { page, pageSize } = parsePagination(searchParams);
    const status = searchParams.get("status") || "";

    const where: Record<string, unknown> = {};
    if (status) {
      if (!VALID_STATUSES.includes(status)) {
        return apiError("无效的任务状态筛选值", 400);
      }
      where.status = status;
    }

    return paginatedList(db.scrapeTask, {
      page,
      pageSize,
      where,
      orderBy: { createdAt: "desc" },
      include: {
        rule: { select: { id: true, name: true } },
      },
      itemsKey: 'tasks',
    });
  } catch (error) {
    console.error("List scrape tasks error:", error);
    return apiError("获取采集任务列表失败");
  }
});

// POST /api/scrape-tasks - Create a new scrape task and auto-trigger execution
export const POST = withAuth(async function POST(request: NextRequest) {
  try {
    // ── Per-endpoint rate limit: 5 task creations per minute ──
    const ip = getClientIp(request);
    const rl = rateLimit(`task-create:${ip}`, {
      capacity: TASK_CREATE_CAPACITY,
      refillRate: TASK_CREATE_REFILL,
    });
    if (!rl.allowed) {
      return NextResponse.json(
        { error: '创建任务过于频繁，每分钟最多创建5个任务' },
        {
          status: 429,
          headers: {
            'Retry-After': String(rl.retryAfter),
            'X-RateLimit-Remaining': '0',
          },
        },
      );
    }

    let body;
    try {
      body = await safeJson(request);
    } catch {
      return apiError("请求数据格式错误", 400);
    }
    const { ruleId, mode, autoStart, listUrlOverride } = body;

    // ── Input validation ──
    if (!ruleId || typeof ruleId !== 'string' || ruleId.trim().length === 0) {
      return apiError("规则ID不能为空且必须为字符串", 400);
    }

    if (mode !== undefined && mode !== null && !VALID_TASK_MODES.includes(mode as string)) {
      return apiError(`mode 必须为以下值之一: ${VALID_TASK_MODES.join(', ')}`, 400);
    }

    if (autoStart !== undefined && typeof autoStart !== 'boolean') {
      return apiError("autoStart 必须为布尔值", 400);
    }

    if (listUrlOverride !== undefined && listUrlOverride !== null) {
      if (typeof listUrlOverride !== 'string' || listUrlOverride.trim().length === 0) {
        return apiError("listUrlOverride 必须为非空字符串", 400);
      }
    }

    // Verify the rule exists
    const rule = await db.scrapeRule.findUnique({ where: { id: ruleId }, select: { id: true, scrapeMode: true } });
    if (!rule) {
      return apiError("采集规则不存在", 404);
    }

    const taskMode = VALID_TASK_MODES.includes(mode as string) ? (mode as string) : (rule.scrapeMode || "incremental");

    const task = await db.scrapeTask.create({
      data: {
        ruleId,
        mode: taskMode,
        status: "pending",
        ...(listUrlOverride ? { listUrlOverride: listUrlOverride.trim() } : {}),
      },
      include: {
        rule: { select: { id: true, name: true } },
      },
    });

    // Auto-trigger scraper-service to execute the task
    // Default: autoStart = true unless explicitly set to false
    const shouldAutoStart = autoStart !== false;
    if (shouldAutoStart) {
      const scraperUrl = SCRAPER_SERVICE_URL;
      fetch(`${scraperUrl}/execute-task`, {
        method: "POST",
        headers: getScraperServiceHeaders(),
        body: JSON.stringify({ taskId: task.id }),
        signal: AbortSignal.timeout(5000),
      }).catch(async (err) => {
        console.error(`[Scrape Task] Failed to auto-trigger task ${task.id}:`, err);
        // Only update to failed if still pending (avoid overwriting running/completed)
        try {
          const safeMsg = err instanceof Error
            ? err.message.replace(/https?:\/\/[^\s]+/g, '[URL]')
            : '未知错误';
          const { count } = await db.scrapeTask.updateMany({
            where: { id: task.id, status: "pending" },
            data: { status: "failed", errorMessage: `触发采集服务失败: ${safeMsg}`, completedAt: new Date() },
          });
          if (count === 0) {
            console.debug(`[Scrape Task] Task already in progress`);
          }
        } catch (dbErr) {
          console.error(`[Scrape Task] Failed to update task ${task.id} status after trigger failure:`, dbErr);
        }
      }).catch((dbErr) => { console.error('[Scrape Task] Unhandled error in failure handler:', dbErr); });
    }

    return apiSuccess(task, 201);
  } catch (error) {
    console.error("Create scrape task error:", error);
    return apiError("创建采集任务失败");
  }
});