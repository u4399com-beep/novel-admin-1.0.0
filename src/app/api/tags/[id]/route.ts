import { db } from "@/lib/db";
import { safeJson, sanitizeField, isPrismaError, apiError } from "@/lib/api-utils";
import { NextRequest, NextResponse } from "next/server";
import { invalidateCache } from "@/lib/cache";
import { withAuth } from "@/lib/api-auth";
import { getOrFail, NotFoundError } from "@/lib/crud-helpers";
import { MAX_NAME_LENGTH, VALID_COLOR_RE } from "@/lib/validation/tags";

// GET /api/tags/[id] - Get a single tag
export const GET = withAuth(async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const tag = await db.tag.findUniqueOrThrow({
      where: { id },
      include: { _count: { select: { novels: true } } },
    });
    return NextResponse.json(tag);
  } catch (error) {
    if (isPrismaError(error, 'P2025')) {
      return apiError('标签不存在', 404);
    }
    console.error("Get tag error:", error);
    return apiError("获取标签详情失败");
  }
});

// PUT /api/tags/[id] - Update a tag
export const PUT = withAuth(async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await getOrFail(db.tag, { id }, '标签不存在');

    let body;
    try {
      body = await safeJson(request);
    } catch {
      return apiError("请求数据格式错误", 400);
    }
    const { name, color } = body;

    if (name !== undefined && !name?.trim()) {
      return apiError("标签名称不能为空", 400);
    }
    if (name !== undefined && name.trim().length > MAX_NAME_LENGTH) {
      return apiError(`标签名称不能超过${MAX_NAME_LENGTH}个字符`, 400);
    }
    if (color !== undefined && color && !VALID_COLOR_RE.test(color)) {
      return apiError("颜色格式无效，请使用HEX格式（如#6b7280）", 400);
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
    invalidateCache("dashboard:stats");

    return NextResponse.json(tag);
  } catch (error: unknown) {
    if (error instanceof NotFoundError) {
      return apiError(error.message, 404);
    }
    console.error("Update tag error:", error);
    if (isPrismaError(error, "P2002")) {
      return apiError("标签名称已存在", 409);
    }
    if (isPrismaError(error, "P2025")) {
      return apiError("标签不存在", 404);
    }
    return apiError("更新标签失败");
  }
});

// DELETE /api/tags/[id] - Delete a tag (RESTful path parameter)
export const DELETE = withAuth(async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    await db.$transaction(async (tx) => {
      await getOrFail(tx.tag, { id }, '标签不存在');
      const novelCount = await tx.novelTag.count({ where: { tagId: id } });
      if (novelCount > 0) {
        throw new Error(`HAS_NOVELS:${novelCount}`);
      }
      await tx.tag.delete({ where: { id } });
    });

    invalidateCache("tags:list");
    invalidateCache("dashboard:stats");
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    if (error instanceof NotFoundError) {
      return apiError(error.message, 404);
    }
    if (error instanceof Error && error.message.startsWith('HAS_NOVELS:')) {
      const count = error.message.split(':')[1];
      return apiError(`无法删除：有 ${count} 本小说正在使用此标签`, 409);
    }
    console.error("Delete tag error:", error);
    if (isPrismaError(error, "P2025")) {
      return apiError("标签不存在", 404);
    }
    return apiError("删除标签失败");
  }
});
