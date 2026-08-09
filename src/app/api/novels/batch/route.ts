import { db } from '@/lib/db';
import { withAuth } from '@/lib/api-auth';
import { NextRequest } from 'next/server';
import { safeJson, apiError, apiSuccess } from '@/lib/api-utils';
import { requireFields } from '@/lib/crud-helpers';
import { invalidateCache } from '@/lib/cache';

const MAX_BATCH_IDS = 100;
const VALID_ACTIONS = ['publish', 'hide', 'delete'] as const;
type BatchAction = (typeof VALID_ACTIONS)[number];

// PATCH /api/novels/batch - Batch operations on novels
// Body: { ids: string[], action: 'publish'|'hide'|'delete', data?: Record<string, unknown> }
export const PATCH = withAuth(async function PATCH(request: NextRequest) {
  try {
    let body;
    try {
      body = await safeJson(request);
    } catch {
      return apiError('请求数据格式错误', 400);
    }

    const check = requireFields(body, ['ids', 'action']);
    if (!check.valid) return check.response;

    const { ids, action } = body;

    // Validate ids
    if (!Array.isArray(ids) || ids.length === 0) {
      return apiError('ids必须为非空数组', 400);
    }
    if (ids.length > MAX_BATCH_IDS) {
      return apiError(`单次最多操作${MAX_BATCH_IDS}个小说`, 400);
    }
    for (let i = 0; i < ids.length; i++) {
      if (typeof ids[i] !== 'string' || !ids[i].trim()) {
        return apiError(`ids[${i}]必须为非空字符串`, 400);
      }
    }

    // Validate action
    if (!VALID_ACTIONS.includes(action)) {
      return apiError(`无效的action，允许值: ${VALID_ACTIONS.join(', ')}`, 400);
    }

    // Verify all novels exist
    const existingNovels = await db.novel.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    if (existingNovels.length !== ids.length) {
      const existingIds = new Set(existingNovels.map((n) => n.id));
      const missing = ids.filter((id: string) => !existingIds.has(id));
      return apiError(`以下小说不存在: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '...' : ''}`, 400);
    }

    let updated = 0;

    switch (action as BatchAction) {
      case 'publish': {
        const result = await db.novel.updateMany({
          where: { id: { in: ids } },
          data: { status: 'ongoing' },
        });
        updated = result.count;
        break;
      }

      case 'hide': {
        const result = await db.novel.updateMany({
          where: { id: { in: ids } },
          data: { status: 'draft' },
        });
        updated = result.count;
        break;
      }

      case 'delete': {
        // Transaction: delete chapters first (cascaded by DB), then novels
        // Also clean up favorites
        await db.$transaction([
          db.favorite.deleteMany({ where: { novelId: { in: ids } } }),
          db.novel.deleteMany({ where: { id: { in: ids } } }),
        ]);
        updated = ids.length;
        invalidateCache('dashboard:stats');
        invalidateCache('dashboard:activity');
        break;
      }
    }

    return apiSuccess({ updated });
  } catch (error) {
    console.error('Batch novels error:', error);
    return apiError('批量操作失败');
  }
});
