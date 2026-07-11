import { db } from "@/lib/db";
import { safeJson } from "@/lib/api-utils";
import { NextRequest, NextResponse } from "next/server";
import { invalidateCache } from "@/lib/cache";
import { withAuth } from "@/lib/api-auth";

const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 1000;
const VALID_COLOR_RE = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;

export const GET = withAuth(async function GET() {
  try {
    const categories = await db.category.findMany({
      orderBy: { sortOrder: "asc" },
      take: 500,
      include: { _count: { select: { novels: true } } },
    });
    return NextResponse.json(categories);
  } catch (error) {
    console.error("List categories error:", error);
    return NextResponse.json({ error: "获取分类列表失败" }, { status: 500 });
  }
});

export const POST = withAuth(async function POST(request: NextRequest) {
  try {
    let body;
    try {
      body = await safeJson(request);
    } catch {
      return NextResponse.json({ error: "请求数据格式错误" }, { status: 400 });
    }
    const { name, description, color, sortOrder } = body;

    if (!name?.trim()) {
      return NextResponse.json({ error: "分类名称不能为空" }, { status: 400 });
    }
    if (name.trim().length > MAX_NAME_LENGTH) {
      return NextResponse.json({ error: `分类名称不能超过${MAX_NAME_LENGTH}个字符` }, { status: 400 });
    }
    if (description && typeof description === "string" && description.trim().length > MAX_DESCRIPTION_LENGTH) {
      return NextResponse.json({ error: `分类描述不能超过${MAX_DESCRIPTION_LENGTH}个字符` }, { status: 400 });
    }
    if (color && !VALID_COLOR_RE.test(color)) {
      return NextResponse.json({ error: "颜色格式无效，请使用HEX格式（如#6b7280）" }, { status: 400 });
    }

    const category = await db.category.create({
      data: {
        name: name.trim(),
        description: description?.trim() || null,
        color: color || "#6b7280",
        sortOrder: Math.max(0, Math.floor(Number(sortOrder) || 0)),
      },
      include: { _count: { select: { novels: true } } },
    });

    invalidateCache("dashboard:stats");

    return NextResponse.json(category, { status: 201 });
  } catch (error: unknown) {
    console.error("Create category error:", error);
    if (error && typeof error === "object" && "code" in error && (error as { code: string }).code === "P2002") {
      return NextResponse.json({ error: "分类名称已存在" }, { status: 409 });
    }
    return NextResponse.json({ error: "创建分类失败" }, { status: 500 });
  }
});

export const PUT = withAuth(async function PUT(request: NextRequest) {
  try {
    let body;
    try {
      body = await safeJson(request);
    } catch {
      return NextResponse.json({ error: "请求数据格式错误" }, { status: 400 });
    }
    const { id, name, description, color, sortOrder } = body;

    if (!id) {
      return NextResponse.json({ error: "缺少分类 ID" }, { status: 400 });
    }
    if (name !== undefined && !name?.trim()) {
      return NextResponse.json({ error: "分类名称不能为空" }, { status: 400 });
    }
    if (name !== undefined && name.trim().length > MAX_NAME_LENGTH) {
      return NextResponse.json({ error: `分类名称不能超过${MAX_NAME_LENGTH}个字符` }, { status: 400 });
    }
    if (description !== undefined && typeof description === "string" && description.trim().length > MAX_DESCRIPTION_LENGTH) {
      return NextResponse.json({ error: `分类描述不能超过${MAX_DESCRIPTION_LENGTH}个字符` }, { status: 400 });
    }
    if (color !== undefined && color && !VALID_COLOR_RE.test(color)) {
      return NextResponse.json({ error: "颜色格式无效，请使用HEX格式（如#6b7280）" }, { status: 400 });
    }

    const category = await db.category.update({
      where: { id },
      data: {
        ...(name !== undefined && { name: name.trim() }),
        ...(description !== undefined && { description: description?.trim() || null }),
        ...(color !== undefined && { color: color || "#6b7280" }),
        ...(sortOrder !== undefined && { sortOrder: Math.max(0, Math.floor(Number(sortOrder) || 0)) }),
      },
      include: { _count: { select: { novels: true } } },
    });

    invalidateCache("dashboard:stats");

    return NextResponse.json(category);
  } catch (error: unknown) {
    console.error("Update category error:", error);
    if (error && typeof error === "object" && "code" in error && (error as { code: string }).code === "P2002") {
      return NextResponse.json({ error: "分类名称已存在" }, { status: 409 });
    }
    return NextResponse.json({ error: "更新分类失败" }, { status: 500 });
  }
});

export const DELETE = withAuth(async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");

    if (!id) {
      return NextResponse.json({ error: "缺少分类 ID" }, { status: 400 });
    }

    await db.category.delete({ where: { id } });
    invalidateCache("dashboard:stats");
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Delete category error:", error);
    return NextResponse.json({ error: "删除分类失败" }, { status: 500 });
  }
});