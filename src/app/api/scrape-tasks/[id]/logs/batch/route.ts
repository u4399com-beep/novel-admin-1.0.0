import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { withAuth } from "@/lib/api-auth";
import { sanitizeField } from "@/lib/api-utils";

const MAX_BATCH_SIZE = 100;
const MAX_MESSAGE_LENGTH = 500;
const MAX_DETAIL_LENGTH = 1000;
const VALID_LEVELS = ["info", "warn", "error", "success"] as const;

export const POST = withAuth(async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let body: { logs?: Array<{ level: string; message: string; url?: string; detail?: string }> };
  try {
    const text = await request.text();
    if (text.length > 1024 * 1024) {
      return NextResponse.json({ error: "请求体过大" }, { status: 413 });
    }
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "无效的JSON" }, { status: 400 });
  }

  if (!Array.isArray(body.logs) || body.logs.length === 0 || body.logs.length > MAX_BATCH_SIZE) {
    return NextResponse.json({ error: `logs必须是1-${MAX_BATCH_SIZE}条记录的数组` }, { status: 400 });
  }

  try {
    const data = body.logs.map((log) => ({
      taskId: id,
      level: VALID_LEVELS.includes(log.level as typeof VALID_LEVELS[number]) ? log.level : "info",
      message: sanitizeField(log.message, MAX_MESSAGE_LENGTH),
      url: log.url ? sanitizeField(log.url, 2048) : null,
      detail: log.detail ? sanitizeField(log.detail, MAX_DETAIL_LENGTH) : null,
    }));

    await db.scrapeLog.createMany({ data });

    return NextResponse.json({ created: data.length });
  } catch (error) {
    console.error("Batch create logs error:", error);
    return NextResponse.json({ error: "批量创建日志失败" }, { status: 500 });
  }
});