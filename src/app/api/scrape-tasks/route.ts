import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

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

    const task = await db.scrapeTask.create({
      data: {
        ruleId,
        mode: mode || rule.scrapeMode || "incremental",
        status: "pending",
      },
    });

    return NextResponse.json(task, { status: 201 });
  } catch (error) {
    console.error("Create scrape task error:", error);
    return NextResponse.json({ error: "创建采集任务失败" }, { status: 500 });
  }
}