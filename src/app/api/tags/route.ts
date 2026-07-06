import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

export async function GET() {
  try {
    const tags = await db.tag.findMany({
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { novels: true } } },
    });
    return NextResponse.json(tags);
  } catch (error) {
    console.error("List tags error:", error);
    return NextResponse.json({ error: "获取标签列表失败" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, color } = body;

    if (!name?.trim()) {
      return NextResponse.json({ error: "标签名称不能为空" }, { status: 400 });
    }

    const tag = await db.tag.create({
      data: {
        name: name.trim(),
        color: color || "#6b7280",
      },
      include: { _count: { select: { novels: true } } },
    });

    return NextResponse.json(tag, { status: 201 });
  } catch (error: unknown) {
    console.error("Create tag error:", error);
    if (error && typeof error === "object" && "code" in error && (error as { code: string }).code === "P2002") {
      return NextResponse.json({ error: "标签名称已存在" }, { status: 409 });
    }
    return NextResponse.json({ error: "创建标签失败" }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, name, color } = body;

    if (!id) {
      return NextResponse.json({ error: "缺少标签 ID" }, { status: 400 });
    }
    if (name !== undefined && !name?.trim()) {
      return NextResponse.json({ error: "标签名称不能为空" }, { status: 400 });
    }

    const tag = await db.tag.update({
      where: { id },
      data: {
        ...(name !== undefined && { name: name.trim() }),
        ...(color !== undefined && { color }),
      },
      include: { _count: { select: { novels: true } } },
    });

    return NextResponse.json(tag);
  } catch (error: unknown) {
    console.error("Update tag error:", error);
    if (error && typeof error === "object" && "code" in error && (error as { code: string }).code === "P2002") {
      return NextResponse.json({ error: "标签名称已存在" }, { status: 409 });
    }
    return NextResponse.json({ error: "更新标签失败" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");

    if (!id) {
      return NextResponse.json({ error: "缺少标签 ID" }, { status: 400 });
    }

    await db.tag.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Delete tag error:", error);
    return NextResponse.json({ error: "删除标签失败" }, { status: 500 });
  }
}