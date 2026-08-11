import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { parsePagination, sanitizeField, apiError } from "@/lib/api-utils";

/**
 * GET /api/scrape-logs — List scrape logs with filtering and pagination.
 * Query params: taskId, level, page, pageSize
 */
export const GET = withAuth(async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const { page, pageSize, skip } = parsePagination(searchParams);

    const taskId = searchParams.get("taskId");
    const level = searchParams.get("level");
    const urlFilter = sanitizeField(searchParams.get("url"), 500);

    const where: Record<string, unknown> = {};
    if (taskId) where.taskId = taskId;
    if (level && ["info", "warn", "error", "success"].includes(level)) {
      where.level = level;
    }
    if (urlFilter) {
      where.url = { contains: urlFilter };
    }

    const [logs, total] = await Promise.all([
      db.scrapeLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
      }),
      db.scrapeLog.count({ where }),
    ]);

    return NextResponse.json({
      logs,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (err) {
    console.error("[scrape-logs] GET error:", err);
    return apiError("获取采集日志失败", 500);
  }
});
