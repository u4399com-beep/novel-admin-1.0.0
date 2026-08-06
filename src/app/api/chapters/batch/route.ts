import { db } from '@/lib/db';
import { withAuth } from '@/lib/api-auth';
import { NextRequest, NextResponse } from 'next/server';
import { safeJson, sanitizeField, isPrismaError, apiError } from '@/lib/api-utils';
import { requireFields } from '@/lib/crud-helpers';

// PATCH /api/chapters/batch - Batch update chapters
// Body: { ids: string[], updates: { title?: string, sortOrder?: number, status?: string } }
export const PATCH = withAuth(async function PATCH(request: NextRequest) {
  try {
    let body;
    try {
      body = await safeJson(request);
    } catch {
      return apiError('请求数据格式错误', 400);
    }

    const check = requireFields(body, ['ids', 'updates']);
    if (!check.valid) return check.response;

    const { ids, updates } = body;

    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 200) {
      return apiError('ids必须为1-200个ID的数组', 400);
    }

    if (typeof updates !== 'object' || updates === null) {
      return apiError('updates必须为对象', 400);
    }

    // Build Prisma update data with allowed fields only
    const data: Record<string, unknown> = {};
    if (updates.title !== undefined) {
      const title = sanitizeField(updates.title, 500);
      if (!title) return apiError('标题不能为空', 400);
      data.title = title;
    }
    if (updates.sortOrder !== undefined) {
      const order = Math.floor(Number(updates.sortOrder));
      if (isNaN(order) || order < 0) return apiError('sortOrder必须为非负整数', 400);
      data.sortOrder = order;
    }
    if (updates.status !== undefined) {
      const status = sanitizeField(updates.status, 50);
      if (!['published', 'draft', 'hidden'].includes(status)) {
        return apiError('status必须是published/draft/hidden', 400);
      }
      data.status = status;
    }

    if (Object.keys(data).length === 0) {
      return apiError('没有可更新的字段', 400);
    }

    const result = await db.chapter.updateMany({
      where: { id: { in: ids } },
      data,
    });

    return NextResponse.json({ updated: result.count });
  } catch (error) {
    console.error('Batch update chapters error:', error);
    if (isPrismaError(error, 'P2025')) {
      return apiError('部分章节不存在', 404);
    }
    return apiError('批量更新章节失败');
  }
});
