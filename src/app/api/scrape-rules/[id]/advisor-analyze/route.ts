import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { db } from '@/lib/db';
import { apiError, isPrismaError } from '@/lib/api-utils';
import { safeHostname } from '@/lib/utils';
import { getOrFail, NotFoundError } from '@/lib/crud-helpers';
import { SCRAPER_SERVICE_URL, getScraperServiceHeaders } from '@/lib/constants';

const SCRAPER_TIMEOUT = 15000;

/** Mock fallback when scraper-service is not reachable */
function mockAdviseResult(domain: string, currentConfig: Record<string, unknown>) {
  return {
    domain,
    threatLevel: 'low' as const,
    signals: [],
    recommendations: [
      {
        id: 'mock-rule-1',
        category: 'engine',
        priority: 30,
        title: 'scraper-service 不可达',
        description: '使用模拟数据，无法分析真实检测信号',
        configKey: 'engine',
        currentValue: 'unknown',
        recommendedValue: 'playwright',
        reasoning: '默认建议',
        estimatedImpact: 'low' as const,
      },
    ],
    currentConfig,
    score: 0,
    potentialScore: 30,
    serviceReachable: false,
  };
}

// POST /api/scrape-rules/[id]/advisor-analyze
export const POST = withAuth(async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // Fetch the rule to get its listUrl and current config
    const rule = await getOrFail<{ listUrl: string | null; antiCrawlConfig: string | null }>(db.scrapeRule, { id }, '采集规则不存在');

    if (!rule.listUrl) {
      return apiError('该规则未设置列表页URL', 400);
    }

    const domain = safeHostname(rule.listUrl, '');
    if (!domain) {
      return apiError('无法从列表页URL提取域名', 400);
    }

    // Parse existing antiCrawlConfig
    let currentConfig: Record<string, unknown> = {};
    if (rule.antiCrawlConfig) {
      try {
        currentConfig = JSON.parse(rule.antiCrawlConfig) as Record<string, unknown>;
      } catch {
        currentConfig = {};
      }
    }

    // Call scraper-service anti-crawl advisor
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SCRAPER_TIMEOUT);

    let res: Response;
    try {
      res = await fetch(`${SCRAPER_SERVICE_URL}/anti-crawl/advise?XTransformPort=3099`, {
        method: 'POST',
        headers: getScraperServiceHeaders(),
        body: JSON.stringify({ domain, currentConfig }),
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timer);
      return NextResponse.json(mockAdviseResult(domain, currentConfig));
    }
    clearTimeout(timer);

    if (!res.ok) {
      return NextResponse.json(mockAdviseResult(domain, currentConfig));
    }

    const data = await res.json();
    return NextResponse.json({ ...data, serviceReachable: true });
  } catch (error: unknown) {
    if (error instanceof NotFoundError) {
      return apiError(error.message, 404);
    }
    if (isPrismaError(error, 'P2025')) {
      return apiError('采集规则不存在', 404);
    }
    console.error('Advisor analyze error:', error);
    return apiError('规则分析失败', 500);
  }
});
