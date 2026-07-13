import { db } from "@/lib/db";
import { safeJson, sanitizeField, isPrismaError } from "@/lib/api-utils";
import { NextRequest, NextResponse } from "next/server";
import { getOrCompute, invalidateCache } from "@/lib/cache";
import { withAuth } from "@/lib/api-auth";

const VALID_IDENTIFIER_RE = /^[a-zA-Z0-9_-]+$/;
const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_IDENTIFIER_LENGTH = 100;
const MAX_CONFIG_SIZE = 102400; // 100KB

// GET /api/themes - List all themes
export const GET = withAuth(async function GET() {
  try {
    const themes = await getOrCompute("themes:list", 30_000, () =>
      db.theme.findMany({
        orderBy: { createdAt: "desc" },
        take: 100,
        include: {
          _count: { select: { sites: true } },
        },
      })
    );
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
    if (typeof identifier !== 'string' || !identifier.trim()) {
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
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return NextResponse.json({ error: "enabled 必须是布尔值" }, { status: 400 });
    }
    if (!config) {
      return NextResponse.json({ error: "主题配置不能为空" }, { status: 400 });
    }

    const configStr = typeof config === "string" ? config : JSON.stringify(config);
    if (configStr.length > MAX_CONFIG_SIZE) {
      return NextResponse.json({ error: `主题配置大小不能超过${Math.floor(MAX_CONFIG_SIZE / 1024)}KB` }, { status: 400 });
    }
    try {
      JSON.parse(configStr);
    } catch {
      return NextResponse.json({ error: "主题配置必须是合法的JSON" }, { status: 400 });
    }

    const theme = await db.theme.create({
      data: {
        name: sanitizeField(name, MAX_NAME_LENGTH),
        description: sanitizeField(description, MAX_DESCRIPTION_LENGTH) || null,
        identifier: sanitizeField(identifier, MAX_IDENTIFIER_LENGTH),
        preview: sanitizeField(preview, 500) || null,
        config: (() => {
          try {
            return JSON.stringify(typeof config === "string" ? JSON.parse(config) : config);
          } catch {
            return JSON.stringify(config);
          }
        })(),
        enabled: typeof enabled === 'boolean' ? enabled : true,
      },
      include: {
        _count: { select: { sites: true } },
      },
    });

    invalidateCache("themes:list");

    return NextResponse.json(theme, { status: 201 });
  } catch (error: unknown) {
    console.error("Create theme error:", error);
    if (isPrismaError(error, "P2002")) {
      return NextResponse.json({ error: "主题名称或标识符已存在" }, { status: 409 });
    }
    return NextResponse.json({ error: "创建主题失败" }, { status: 500 });
  }
});