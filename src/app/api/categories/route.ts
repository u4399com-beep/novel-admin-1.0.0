import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

export async function GET() {
  try {
    const categories = await db.category.findMany({
      orderBy: { sortOrder: "asc" },
      include: { _count: { select: { novels: true } } },
    });
    return NextResponse.json(categories);
  } catch (error) {
    console.error("List categories error:", error);
    return NextResponse.json({ error: "获取分类列表失败" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, description, color, sortOrder } = body;

    if (!name?.trim()) {
      return NextResponse.json({ error: "分类名称不能为空" }, { status: 400 });
    }

    const category = await db.category.create({
      data: {
        name: name.trim(),
        description: description?.trim() || null,
        color: color || "#6b7280",
        sortOrder: sortOrder || 0,
      },
      include: { _count: { select: { novels: true } } },
    });

    return NextResponse.json(category, { status: 201 });
  } catch (error: unknown) {
    console.error("Create category error:", error);
    if (error && typeof error === "object" && "code" in error && (error as { code: string }).code === "P2002") {
      return NextResponse.json({ error: "分类名称已存在" }, { status: 409 });
    }
    return NextResponse.json({ error: "创建分类失败" }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, name, description, color, sortOrder } = body;

    if (!id) {
      return NextResponse.json({ error: "缺少分类 ID" }, { status: 400 });
    }
    if (name !== undefined && !name?.trim()) {
      return NextResponse.json({ error: "分类名称不能为空" }, { status: 400 });
    }

    const category = await db.category.update({
      where: { id },
      data: {
        ...(name !== undefined && { name: name.trim() }),
        ...(description !== undefined && { description: description?.trim() || null }),
        ...(color !== undefined && { color }),
        ...(sortOrder !== undefined && { sortOrder }),
      },
      include: { _count: { select: { novels: true } } },
    });

    return NextResponse.json(category);
  } catch (error: unknown) {
    console.error("Update category error:", error);
    if (error && typeof error === "object" && "code" in error && (error as { code: string }).code === "P2002") {
      return NextResponse.json({ error: "分类名称已存在" }, { status: 409 });
    }
    return NextResponse.json({ error: "更新分类失败" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");

    if (!id) {
      return NextResponse.json({ error: "缺少分类 ID" }, { status: 400 });
    }

    await db.category.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Delete category error:", error);
    return NextResponse.json({ error: "删除分类失败" }, { status: 500 });
  }
}