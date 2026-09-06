import { withAuth } from '@/lib/api-auth';
import { SCRAPER_SERVICE_URL, getScraperServiceHeaders } from '@/lib/constants';
import { NextResponse } from 'next/server';
import { apiError, safeJson } from '@/lib/api-utils';

const SCRAPER_TIMEOUT = 8000;

/** Mock fallback when scraper-service is not reachable */
function mockAdviseResult(domain: string) {
  return {
    domain,
    threatLevel: 'low' as const,
    signals: [],
    recommendations: [
      {
        id: 'mock-1',
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
    currentConfig: {},
    score: 0,
    potentialScore: 30,
    serviceReachable: false,
  };
}

// POST /api/admin/scraper/anti-crawl-advise
export const POST = withAuth(async function POST(request: Request) {
  let body: { domain?: string; currentConfig?: Record<string, unknown> };
  try {
    body = await safeJson<{ domain?: string; currentConfig?: Record<string, unknown> }>(request);
  } catch {
    return apiError('请求数据格式错误', 400);
  }

  try {
    if (!body.domain || typeof body.domain !== 'string') {
      return apiError('domain is required', 400);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SCRAPER_TIMEOUT);

    let res: Response;
    try {
      res = await fetch(`${SCRAPER_SERVICE_URL}/anti-crawl/advise?XTransformPort=3099`, {
        method: 'POST',
        headers: getScraperServiceHeaders(),
        body: JSON.stringify({ domain: body.domain, currentConfig: body.currentConfig }),
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timer);
      return NextResponse.json(mockAdviseResult(body.domain));
    }
    clearTimeout(timer);

    if (!res.ok) {
      return NextResponse.json(mockAdviseResult(body.domain));
    }

    const data = await res.json();
    return NextResponse.json({ ...data, serviceReachable: true });
  } catch (error) {
    console.error('Anti-crawl advise error:', error);
    return apiError('智能分析失败', 500);
  }
});
