import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { safeJson, apiError } from '@/lib/api-utils';
import { isSafeUrl } from '@/lib/sanitize';
import { SCRAPER_SERVICE_URL, getScraperServiceHeaders } from '@/lib/constants';

const SCRAPER_TIMEOUT = 30_000; // 30s timeout

/** Mock fallback when scraper-service is not reachable */
function mockTestRuleResult(url: string) {
  return {
    success: false,
    url,
    finalUrl: url,
    statusCode: 0,
    engine: 'cheerio',
    responseTime: 0,
    htmlLength: 0,
    headers: {},
    rateLimitState: { domain: 'unknown', status: 'normal', maxRPM: 30, currentRPM: 0 },
    delayState: { domain: 'unknown', status: 'normal', currentDelay: 0, backoffLevel: 0 },
    signals: [],
    serviceReachable: false,
  };
}

// POST /api/scrape-rules/test-rule
// Body: { url, engine?, antiCrawlConfig?, listSelector? }
// Proxies to scraper-service /test-rule?XTransformPort=3099
export const POST = withAuth(async function POST(request: NextRequest) {
  try {
    let body;
    try {
      body = await safeJson(request);
    } catch {
      return apiError('请求数据格式错误', 400);
    }

    const { url, engine, antiCrawlConfig, listSelector } = body;

    // Validate url is present
    if (!url || typeof url !== 'string') {
      return apiError('缺少必需的 url 参数', 400);
    }

    // Validate URL format
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return apiError('无效的 URL 格式', 400);
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return apiError('仅支持 http/https 协议', 400);
    }

    // Limit URL length
    if (url.length > 2048) {
      return apiError('URL 过长', 400);
    }

    // SSRF protection
    if (!isSafeUrl(url)) {
      return apiError('URL 不允许访问内网或私有地址', 400);
    }

    // Build the payload to forward (only include known fields)
    const payload: Record<string, unknown> = { url };
    if (engine !== undefined && engine !== null) {
      payload.engine = engine;
    }
    if (antiCrawlConfig !== undefined && antiCrawlConfig !== null) {
      payload.antiCrawlConfig = antiCrawlConfig;
    }
    if (listSelector !== undefined && listSelector !== null) {
      payload.listSelector = listSelector;
    }

    // Proxy to scraper-service
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SCRAPER_TIMEOUT);

    let res: Response;
    try {
      res = await fetch(`${SCRAPER_SERVICE_URL}/test-rule?XTransformPort=3099`, {
        method: 'POST',
        headers: getScraperServiceHeaders(),
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timeoutId);
      return NextResponse.json(mockTestRuleResult(url));
    }
    clearTimeout(timeoutId);

    if (!res.ok) {
      return NextResponse.json(mockTestRuleResult(url));
    }

    const data = await res.json();
    return NextResponse.json({ ...data, serviceReachable: true });
  } catch (error) {
    console.error('[test-rule] Error:', error);
    return apiError('规则测试失败', 500);
  }
});
