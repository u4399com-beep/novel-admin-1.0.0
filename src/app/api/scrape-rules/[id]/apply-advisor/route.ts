import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { db } from '@/lib/db';
import { safeJson, apiError, isPrismaError, safeJsonStringify } from '@/lib/api-utils';
import { getOrFail, NotFoundError } from '@/lib/crud-helpers';

// PUT /api/scrape-rules/[id]/apply-advisor
export const PUT = withAuth(async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // Validate request body
    let body: {
      recommendations?: Array<{ configKey: string; recommendedValue: unknown }>;
    };
    try {
      body = await safeJson<{
        recommendations?: Array<{ configKey: string; recommendedValue: unknown }>;
      }>(request);
    } catch {
      return apiError('请求数据格式错误', 400);
    }

    if (!Array.isArray(body.recommendations) || body.recommendations.length === 0) {
      return apiError('recommendations 必须是非空数组', 400);
    }

    // Limit max recommendations to prevent abuse
    if (body.recommendations.length > 50) {
      return apiError('recommendations 最多50条', 400);
    }

    // Fetch the rule
    const rule = await getOrFail<{ antiCrawlConfig: string | null }>(db.scrapeRule, { id }, '采集规则不存在');

    // Parse existing antiCrawlConfig
    let antiCrawlConfig: Record<string, unknown> = {};
    if (rule.antiCrawlConfig) {
      try {
        antiCrawlConfig = JSON.parse(rule.antiCrawlConfig) as Record<string, unknown>;
      } catch {
        antiCrawlConfig = {};
      }
    }

    // Fields to update on the rule itself
    const ruleUpdate: Record<string, unknown> = {};

    // Apply each recommendation
    let appliedCount = 0;
    for (const rec of body.recommendations) {
      if (!rec.configKey || typeof rec.configKey !== 'string') continue;

      const key = rec.configKey;
      const val = rec.recommendedValue;

      switch (key) {
        case 'engine':
          // Update the rule's engine field directly
          if (typeof val === 'string') {
            ruleUpdate.engine = val;
            appliedCount++;
          }
          break;
        case 'proxy':
          // Set antiCrawlConfig.proxy to the proxy URL string
          if (typeof val === 'string') {
            antiCrawlConfig.proxy = val;
            appliedCount++;
          }
          break;
        case 'delay':
          // Set antiCrawlConfig.delay to [minMs, maxMs] array
          if (Array.isArray(val) && val.length === 2 && typeof val[0] === 'number' && typeof val[1] === 'number') {
            antiCrawlConfig.delay = [val[0], val[1]];
            appliedCount++;
          }
          break;
        case 'uaRotation':
          // Set antiCrawlConfig.uaRotation to boolean
          antiCrawlConfig.uaRotation = !!val;
          appliedCount++;
          break;
        case 'useJsRender':
          // Set antiCrawlConfig.useJsRender to boolean
          antiCrawlConfig.useJsRender = !!val;
          appliedCount++;
          break;
        case 'humanBehavior':
          // Set antiCrawlConfig.humanBehavior to boolean
          antiCrawlConfig.humanBehavior = !!val;
          appliedCount++;
          break;
        case 'cookies':
          // Set antiCrawlConfig.cookies to array
          if (Array.isArray(val)) {
            antiCrawlConfig.cookies = val;
            appliedCount++;
          }
          break;
        case 'retries':
          // Set antiCrawlConfig.retries to number
          if (typeof val === 'number' && val >= 0) {
            antiCrawlConfig.retries = val;
            appliedCount++;
          }
          break;
        default:
          // For unknown keys, try to set directly on antiCrawlConfig
          antiCrawlConfig[key] = val;
          appliedCount++;
          break;
      }
    }

    // Validate final antiCrawlConfig is JSON-serializable
    let serializedConfig: string;
    try {
      serializedConfig = safeJsonStringify(antiCrawlConfig, 'antiCrawlConfig') ?? '{}';
      // Double-check round-trip
      JSON.parse(serializedConfig);
    } catch (e) {
      return apiError(e instanceof Error ? e.message : '反爬配置序列化失败', 400);
    }

    // Update the rule in the database
    const updatedRule = await db.scrapeRule.update({
      where: { id },
      data: {
        antiCrawlConfig: serializedConfig,
        ...ruleUpdate,
      },
    });

    // Return the updated antiCrawlConfig
    let resultConfig: Record<string, unknown> = {};
    try {
      resultConfig = JSON.parse(updatedRule.antiCrawlConfig ?? '{}') as Record<string, unknown>;
    } catch {
      resultConfig = {};
    }

    return NextResponse.json({
      success: true,
      appliedCount,
      antiCrawlConfig: resultConfig,
    });
  } catch (error: unknown) {
    if (error instanceof NotFoundError) {
      return apiError(error.message, 404);
    }
    if (isPrismaError(error, 'P2025')) {
      return apiError('采集规则不存在', 404);
    }
    console.error('Apply advisor recommendations error:', error);
    return apiError('应用建议失败', 500);
  }
});
