import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

// GET /api/themes/[id] - Get a single theme
export async function GET(
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
}

// PUT /api/themes/[id] - Update a theme
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { name, description, identifier, preview, config, enabled } = body;

    if (name !== undefined && !name?.trim()) {
      return NextResponse.json({ error: "主题名称不能为空" }, { status: 400 });
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
  } catch (error) {
    console.error("Update theme error:", error);
    return NextResponse.json({ error: "更新主题失败" }, { status: 500 });
  }
}

// DELETE /api/themes/[id] - Delete a theme
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await db.theme.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Delete theme error:", error);
    return NextResponse.json({ error: "删除主题失败" }, { status: 500 });
  }
}