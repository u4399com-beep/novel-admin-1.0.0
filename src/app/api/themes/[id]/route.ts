import { db } from "@/lib/db";
import { safeJson } from "@/lib/api-utils";
import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";

const VALID_IDENTIFIER_RE = /^[a-zA-Z0-9_-]+$/;
const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_IDENTIFIER_LENGTH = 100;

// GET /api/themes/[id] - Get a single theme
export const GET = withAuth(async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const theme = await db.theme.findUnique({
      where: { id },
      include: {
        _count: { select: { sites: true } },
      },
    });

    if (!theme) {
      return NextResponse.json({ error: "主题不存在" }, { status: 404 });
    }

    return NextResponse.json(theme);
  } catch (error) {
    console.error("Get theme error:", error);
    return NextResponse.json({ error: "获取主题详情失败" }, { status: 500 });
  }
});

// PUT /api/themes/[id] - Update a theme
export const PUT = withAuth(async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    let body;
    try {
      body = await safeJson(request);
    } catch {
      return NextResponse.json({ error: "请求数据格式错误" }, { status: 400 });
    }
    const { name, description, identifier, preview, config, enabled } = body;

    if (name !== undefined && !name?.trim()) {
      return NextResponse.json({ error: "主题名称不能为空" }, { status: 400 });
    }
    if (name !== undefined && name.trim().length > MAX_NAME_LENGTH) {
      return NextResponse.json({ error: `主题名称不能超过${MAX_NAME_LENGTH}个字符` }, { status: 400 });
    }
    if (identifier !== undefined) {
      if (!identifier?.trim()) {
        return NextResponse.json({ error: "主题标识符不能为空" }, { status: 400 });
      }
      if (!VALID_IDENTIFIER_RE.test(identifier.trim())) {
        return NextResponse.json({ error: "主题标识符只能包含字母、数字、下划线和短横线" }, { status: 400 });
      }
      if (identifier.trim().length > MAX_IDENTIFIER_LENGTH) {
        return NextResponse.json({ error: `主题标识符不能超过${MAX_IDENTIFIER_LENGTH}个字符` }, { status: 400 });
      }
    }
    if (description !== undefined && typeof description === "string" && description.trim().length > MAX_DESCRIPTION_LENGTH) {
      return NextResponse.json({ error: `主题描述不能超过${MAX_DESCRIPTION_LENGTH}个字符` }, { status: 400 });
    }

    const theme = await db.theme.update({
      where: { id },
      data: {
        ...(name !== undefined && { name: name.trim() }),
        ...(description !== undefined && { description: description?.trim() || null }),
        ...(identifier !== undefined && { identifier: identifier.trim() }),
        ...(preview !== undefined && { preview: preview || null }),
        ...(config !== undefined && {
          config: typeof config === "string" ? config : JSON.stringify(config),
        }),
        ...(enabled !== undefined && { enabled }),
      },
      include: {
        _count: { select: { sites: true } },
      },
    });

    return NextResponse.json(theme);
  } catch (error: unknown) {
    console.error("Update theme error:", error);
    const msg = error instanceof Error && error.message.includes("Unique")
      ? "主题名称或标识符已存在"
      : "更新主题失败";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
});

// DELETE /api/themes/[id] - Delete a theme
export const DELETE = withAuth(async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const existing = await db.theme.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "主题不存在" }, { status: 404 });
    }
    await db.theme.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    console.error("Delete theme error:", error);
    if (error && typeof error === "object" && "code" in error && (error as { code: string }).code === "P2025") {
      return NextResponse.json({ error: "主题不存在" }, { status: 404 });
    }
    return NextResponse.json({ error: "删除主题失败" }, { status: 500 });
  }
});