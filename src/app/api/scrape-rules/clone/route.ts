import { db } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { safeJson, apiError, apiSuccess } from '@/lib/api-utils';
import { sanitizeField } from '@/lib/api-utils';

/**
 * POST /api/scrape-rules/clone
 *
 * Accepts { ruleId: string, newName?: string } and creates a deep copy of the rule.
 * If newName is not provided, appends " (副本)" to the original name.
 */
export const POST = withAuth(async function POST(request: NextRequest) {
  try {
    let body: { ruleId?: string; newName?: string };
    try {
      body = await safeJson(request);
    } catch {
      return apiError('请求数据格式错误', 400);
    }

    const { ruleId, newName } = body;

    if (!ruleId || typeof ruleId !== 'string') {
      return apiError('缺少 ruleId 参数', 400);
    }

    // Fetch the original rule
    const original = await db.scrapeRule.findUnique({ where: { id: ruleId } });
    if (!original) {
      return apiError('规则不存在', 404);
    }

    // Generate new name
    const copyName = newName
      ? sanitizeField(newName, 200)
      : sanitizeField(original.name + ' (副本)', 200);

    // Check if a rule with this name already exists
    const existing = await db.scrapeRule.findFirst({ where: { name: copyName } });
    if (existing) {
      return apiError('同名规则已存在，请修改名称', 409);
    }

    // Deep copy all fields (exclude id, createdAt, updatedAt, tasks)
    const { id: _id, createdAt: _ct, updatedAt: _ut, ...ruleData } = original;

    const cloned = await db.scrapeRule.create({
      data: {
        ...ruleData,
        name: copyName,
        enabled: false, // Cloned rules start disabled for safety
      },
    });

    return apiSuccess(cloned, 201);
  } catch (error) {
    console.error('Clone scrape rule error:', error);
    return apiError('克隆采集规则失败');
  }
});
