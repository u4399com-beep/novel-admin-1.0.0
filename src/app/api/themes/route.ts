import { db } from "@/lib/db";
import { safeJson, sanitizeField } from "@/lib/api-utils";
import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";

const VALID_IDENTIFIER_RE = /^[a-zA-Z0-9_-]+$/;
const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_IDENTIFIER_LENGTH = 100;
const MAX_CONFIG_SIZE = 102400; // 100KB

// GET /api/themes - List all themes
export const GET = withAuth(async function GET() {
  try {
    const themes = await db.theme.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        _count: { select: { sites: true } },
      },
    });
    return NextResponse.json(themes);
  } catch (error) {
    console.error("List themes error:", error);
    return NextResponse.json({ error: "获取主题列表失败" }, { status: 500 });
  }
});

// POST /api/themes - Create a theme
export const POST = withAuth(async function POST(request: NextRequest) {
  try {
    let body;
    try {
      body = await safeJson(request);
    } catch {
      return NextResponse.json({ error: "请求数据格式错误" }, { status: 400 });
    }
    const { name, description, identifier, preview, config, enabled } = body;

    if (!name?.trim()) {
      return NextResponse.json({ error: "主题名称不能为空" }, { status: 400 });
    }
    if (name.trim().length > MAX_NAME_LENGTH) {
      return NextResponse.json({ error: `主题名称不能超过${MAX_NAME_LENGTH}个字符` }, { status: 400 });
    }
    if (!identifier?.trim()) {
      return NextResponse.json({ error: "主题标识符不能为空" }, { status: 400 });
    }
    if (!VALID_IDENTIFIER_RE.test(identifier.trim())) {
      return NextResponse.json({ error: "主题标识符只能包含字母、数字、下划线和短横线" }, { status: 400 });
    }
    if (identifier.trim().length > MAX_IDENTIFIER_LENGTH) {
      return NextResponse.json({ error: `主题标识符不能超过${MAX_IDENTIFIER_LENGTH}个字符` }, { status: 400 });
    }
    if (description && typeof description === "string" && description.trim().length > MAX_DESCRIPTION_LENGTH) {
      return NextResponse.json({ error: `主题描述不能超过${MAX_DESCRIPTION_LENGTH}个字符` }, { status: 400 });
    }
    if (!config) {
      return NextResponse.json({ error: "主题配置不能为空" }, { status: 400 });
    }

    const configStr = typeof config === "string" ? config : JSON.stringify(config);
    if (configStr.length > MAX_CONFIG_SIZE) {
      return NextResponse.json({ error: `主题配置大小不能超过${Math.floor(MAX_CONFIG_SIZE / 1024)}KB` }, { status: 400 });
    }

    const theme = await db.theme.create({
      data: {
        name: sanitizeField(name, MAX_NAME_LENGTH),
        description: sanitizeField(description, MAX_DESCRIPTION_LENGTH) || null,
        identifier: sanitizeField(identifier, MAX_IDENTIFIER_LENGTH),
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
    const msg = (error && typeof error === "object" && "code" in error && (error as { code: string }).code === "P2002")
      ? "主题名称或标识符已存在"
      : "创建主题失败";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
});