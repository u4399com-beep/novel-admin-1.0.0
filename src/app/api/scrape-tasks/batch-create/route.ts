import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";
import { safeJson, apiError, apiSuccess } from "@/lib/api-utils";
import { withAuth, rateLimit, getClientIp } from "@/lib/api-auth";
import { SCRAPER_SERVICE_URL, getScraperServiceHeaders } from "@/lib/constants";

const VALID_TASK_MODES = ["incremental", "full"];
const MAX_BATCH_SIZE = 30;

// Batch rate limit: 1 batch per minute per IP
const BATCH_CAPACITY = 3;
const BATCH_REFILL = 3 / 60;

// POST /api/scrape-tasks/batch-create - Create multiple tasks at once (e.g., one per category)
export const POST = withAuth(async function POST(request: NextRequest) {
  try {
    // ── Per-endpoint rate limit ──
    const ip = getClientIp(request);
    const rl = rateLimit(`task-batch:${ip}`, {
      capacity: BATCH_CAPACITY,
      refillRate: BATCH_REFILL,
    });
    if (!rl.allowed) {
      return NextResponse.json(
        { error: '批量创建过于频繁，每分钟最多3次' },
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

    const { ruleId, mode, autoStart, listUrls } = body;

    // ── Input validation ──
    if (!ruleId || typeof ruleId !== 'string' || ruleId.trim().length === 0) {
      return apiError("规则ID不能为空且必须为字符串", 400);
    }

    if (mode !== undefined && mode !== null && !VALID_TASK_MODES.includes(mode)) {
      return apiError(`mode 必须为以下值之一: ${VALID_TASK_MODES.join(', ')}`, 400);
    }

    // listUrls: if provided, create one task per URL. Otherwise create one task with default listUrl.
    let urls: string[] = [];
    if (Array.isArray(listUrls) && listUrls.length > 0) {
      urls = listUrls.filter((u: unknown) => typeof u === 'string' && u.trim().length > 0).map((u: string) => u.trim());
      if (urls.length === 0) {
        return apiError("listUrls 数组为空或所有URL无效", 400);
      }
      if (urls.length > MAX_BATCH_SIZE) {
        return apiError(`单次批量最多创建 ${MAX_BATCH_SIZE} 个任务`, 400);
      }
    }

    // Verify the rule exists
    const rule = await db.scrapeRule.findUnique({
      where: { id: ruleId },
      select: { id: true, name: true, scrapeMode: true, listUrl: true },
    });
    if (!rule) {
      return apiError("采集规则不存在", 404);
    }

    const taskMode = VALID_TASK_MODES.includes(mode) ? mode : (rule.scrapeMode || "incremental");
    const shouldAutoStart = autoStart !== false;

    // If no listUrls provided, create a single task with default URL
    if (urls.length === 0) {
      urls = [rule.listUrl || ''];
    }

    // Create tasks in a transaction
    const tasks = await db.$transaction(async (tx) => {
      const created = [];
      for (const url of urls) {
        const task = await tx.scrapeTask.create({
          data: {
            ruleId,
            mode: taskMode,
            status: "pending",
            listUrlOverride: url || null,
          },
          });
        created.push(task);
      }
      return created;
    });

    // Auto-trigger each task sequentially with small delay
    if (shouldAutoStart) {
      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        // Stagger task starts by 500ms to avoid hammering
        if (i > 0) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        fetch(`${SCRAPER_SERVICE_URL}/execute-task`, {
          method: "POST",
          headers: getScraperServiceHeaders(),
          body: JSON.stringify({ taskId: task.id }),
          signal: AbortSignal.timeout(5000),
        }).catch(async (err) => {
          console.error(`[Batch Task] Failed to auto-trigger task ${task.id}:`, err);
          try {
            const safeMsg = err instanceof Error
              ? err.message.replace(/https?:\/\/[^\s]+/g, '[URL]')
              : '未知错误';
            await db.scrapeTask.updateMany({
              where: { id: task.id, status: "pending" },
              data: { status: "failed", errorMessage: `触发采集服务失败: ${safeMsg}`, completedAt: new Date() },
            });
          } catch { /* */ }
        });
      }
    }

    return apiSuccess({
      tasks: tasks.map(t => ({ id: t.id, status: t.status, listUrlOverride: t.listUrlOverride })),
      totalCreated: tasks.length,
      ruleName: rule.name,
    }, 201);
  } catch (error) {
    console.error("Batch create scrape tasks error:", error);
    return apiError("批量创建采集任务失败", 500);
  }
});
