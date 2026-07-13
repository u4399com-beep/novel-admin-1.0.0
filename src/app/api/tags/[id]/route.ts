import { db } from "@/lib/db";
import { safeJson, sanitizeField, isPrismaError } from "@/lib/api-utils";
import { NextRequest, NextResponse } from "next/server";
import { invalidateCache } from "@/lib/cache";
import { withAuth } from "@/lib/api-auth";

const MAX_NAME_LENGTH = 50;
const VALID_COLOR_RE = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;

// GET /api/tags/[id] - Get a single tag
export const GET = withAuth(async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const tag = await db.tag.findUnique({
      where: { id },
      include: { _count: { select: { novels: true } } },
    });

    if (!tag) {
      return NextResponse.json({ error: "标签不存在" }, { status: 404 });
    }

    return NextResponse.json(tag);
  } catch (error) {
    console.error("Get tag error:", error);
    return NextResponse.json({ error: "获取标签详情失败" }, { status: 500 });
  }
});

// PUT /api/tags/[id] - Update a tag
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
    const { name, color } = body;

    if (name !== undefined && !name?.trim()) {
      return NextResponse.json({ error: "标签名称不能为空" }, { status: 400 });
    }
    if (name !== undefined && name.trim().length > MAX_NAME_LENGTH) {
      return NextResponse.json({ error: `标签名称不能超过${MAX_NAME_LENGTH}个字符` }, { status: 400 });
    }
    if (color !== undefined && color && !VALID_COLOR_RE.test(color)) {
      return NextResponse.json({ error: "颜色格式无效，请使用HEX格式（如#6b7280）" }, { status: 400 });
    }

    const tag = await db.tag.update({
      where: { id },
      data: {
        ...(name !== undefined && { name: sanitizeField(name, MAX_NAME_LENGTH) }),
        ...(color !== undefined && { color: color || "#6b7280" }),
      },
      include: { _count: { select: { novels: true } } },
    });

    invalidateCache("tags:list");

    return NextResponse.json(tag);
  } catch (error: unknown) {
    console.error("Update tag error:", error);
    if (isPrismaError(error, "P2002")) {
      return NextResponse.json({ error: "标签名称已存在" }, { status: 409 });
    }
    if (isPrismaError(error, "P2025")) {
      return NextResponse.json({ error: "标签不存在" }, { status: 404 });
    }
    return NextResponse.json({ error: "更新标签失败" }, { status: 500 });
  }
});

// DELETE /api/tags/[id] - Delete a tag (RESTful path parameter)
export const DELETE = withAuth(async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const existing = await db.tag.findUnique({
      where: { id },
      include: { _count: { select: { novels: true } } },
    });
    if (!existing) {
      return NextResponse.json({ error: "标签不存在" }, { status: 404 });
    }
    if (existing._count.novels > 0) {
      return NextResponse.json(
        { error: `无法删除：有 ${existing._count.novels} 本小说正在使用此标签` },
        { status: 409 }
      );
    }

    await db.tag.delete({ where: { id } });
    invalidateCache("tags:list");
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    console.error("Delete tag error:", error);
    if (isPrismaError(error, "P2025")) {
      return NextResponse.json({ error: "标签不存在" }, { status: 404 });
    }
    return NextResponse.json({ error: "删除标签失败" }, { status: 500 });
  }
});