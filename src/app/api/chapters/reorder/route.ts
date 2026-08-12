import { db } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { withAuth } from '@/lib/api-auth';
import { NextRequest } from 'next/server';
import { safeJson, apiError, apiSuccess } from '@/lib/api-utils';
import { requireFields } from '@/lib/crud-helpers';

const MAX_REORDER_ITEMS = 500;

// PATCH /api/chapters/reorder - Batch reorder chapters
// Body: { items: { id: string, sortOrder: number }[] }
export const PATCH = withAuth(async function PATCH(request: NextRequest) {
  try {
    let body;
    try {
      body = await safeJson(request);
    } catch {
      return apiError('请求数据格式错误', 400);
    }

    const check = requireFields(body, ['items']);
    if (!check.valid) return check.response;

    const { items } = body;

    if (!Array.isArray(items) || items.length === 0) {
      return apiError('items必须为非空数组', 400);
    }
    if (items.length > MAX_REORDER_ITEMS) {
      return apiError(`单次最多排序${MAX_REORDER_ITEMS}个章节`, 400);
    }

    // Validate each item
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item || typeof item !== 'object') {
        return apiError(`items[${i}]格式错误`, 400);
      }
      if (typeof item.id !== 'string' || !item.id.trim()) {
        return apiError(`items[${i}].id必须为非空字符串`, 400);
      }
      if (typeof item.sortOrder !== 'number' || !Number.isInteger(item.sortOrder) || item.sortOrder < 0 || item.sortOrder > 100000) {
        return apiError(`items[${i}].sortOrder必须为非负整数`, 400);
      }
    }

    // Check for duplicate IDs
    const idSet = new Set<string>();
    for (const item of items) {
      if (idSet.has(item.id)) {
        return apiError(`重复的章节ID: ${item.id}`, 400);
      }
      idSet.add(item.id);
    }

    // Verify all chapters exist
    const existingChapters = await db.chapter.findMany({
      where: { id: { in: items.map((item: { id: string }) => item.id) } },
      select: { id: true },
    });
    if (existingChapters.length !== items.length) {
      const existingIds = new Set(existingChapters.map((c) => c.id));
      const missing = items
        .map((item: { id: string }) => item.id)
        .filter((id: string) => !existingIds.has(id));
      return apiError(`以下章节不存在: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '...' : ''}`, 400);
    }

    // Validate IDs are CUIDs (alphanumeric + hyphen only) — safe for SQL
    const CUID_RE = /^[a-z0-9-]+$/;
    for (const item of items) {
      if (!CUID_RE.test(item.id)) {
        return apiError(`无效的章节ID: ${item.id}`, 400);
      }
    }

    // Use batch UPDATE via CASE for better performance (single SQL statement)
    // Use Prisma.sql tagged template for parameterized query (safe from SQL injection)
    const sql = Prisma.sql`
      UPDATE "Chapter" SET "sortOrder" = CASE id
        ${Prisma.join(items.map((item: { id: string; sortOrder: number }) =>
          Prisma.sql`WHEN ${item.id} THEN ${item.sortOrder}`
        ), ' ')}
        ELSE "sortOrder" END
      WHERE id IN (${Prisma.join(items.map((item: { id: string }) => item.id))})
    `;
    await db.$executeRaw(sql);
    const updated = items.length;

    return apiSuccess({ updated });
  } catch (error) {
    console.error('Reorder chapters error:', error);
    return apiError('章节排序失败');
  }
});
