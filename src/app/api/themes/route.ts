import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

// GET /api/themes - List all themes
export async function GET() {
  try {
    const themes = await db.theme.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        _count: { select: { sites: true } },
      },
    });
    return NextResponse.json(themes);
  } catch (error) {
    console.error("List themes error:", error);
    return NextResponse.json({ error: "获取主题列表失败" }, { status: 500 });
  }
}

// POST /api/themes - Create a theme
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, description, identifier, preview, config, enabled } = body;

    if (!name?.trim()) {
      return NextResponse.json({ error: "主题名称不能为空" }, { status: 400 });
    }
    if (!identifier?.trim()) {
      return NextResponse.json({ error: "主题标识符不能为空" }, { status: 400 });
    }
    if (!config) {
      return NextResponse.json({ error: "主题配置不能为空" }, { status: 400 });
    }

    const theme = await db.theme.create({
      data: {
        name: name.trim(),
        description: description?.trim() || null,
        identifier: identifier.trim(),
        preview: preview || null,
        config: typeof config === "string" ? config : JSON.stringify(config),
        enabled: enabled !== undefined ? enabled : true,
      },
      include: {
        _count: { select: { sites: true } },
      },
    });

    return NextResponse.json(theme, { status: 201 });
  } catch (error: unknown) {
    console.error("Create theme error:", error);
    const msg = error instanceof Error && error.message.includes("Unique") 
      ? "主题名称或标识符已存在" 
      : "创建主题失败";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}